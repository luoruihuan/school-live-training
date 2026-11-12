import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { parseImportRows } from "./account.controller.js";

test("账号导入：合法行解析，角色与密码缺省正确", () => {
  const { parsed, issues } = parseImportRows([
    ["stu001", "张三", "学生", ""],
    ["t001@school.cn", "", "教师", "abcd1234"],
    ["stu002", "李四", "", ""]
  ]);
  assert.equal(issues.length, 0);
  assert.deepEqual(parsed.map((row) => row.email), ["stu001", "t001@school.cn", "stu002"]);
  assert.equal(parsed[0].role, "STUDENT");
  assert.equal(parsed[0].password, "123456");
  assert.equal(parsed[0].displayName, "张三");
  assert.equal(parsed[1].role, "TEACHER");
  assert.equal(parsed[1].password, "abcd1234");
  assert.equal(parsed[1].displayName, "t001@school.cn"); // 姓名缺省同账号
  assert.equal(parsed[2].role, "STUDENT");
});

test("账号导入：空行跳过、行号从 2 起（第 1 行为表头）", () => {
  const { parsed, issues } = parseImportRows([
    ["", "", "", ""],
    ["stu001", "", "", ""],
    [undefined, undefined, undefined, undefined]
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(issues.length, 0);
  assert.equal(parsed[0].row, 3);
});

test("账号导入：账号缺失 / 格式非法 / 行内重复 / 密码过短逐行报错", () => {
  const { parsed, issues } = parseImportRows([
    ["", "无账号", "", ""],
    ["bad email!", "", "", ""],
    ["dup001", "", "", ""],
    ["DUP001", "", "", ""],
    ["stu003", "", "", "123"]
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(issues.length, 4);
  assert.match(issues[0].reason, /未填写/);
  assert.match(issues[1].reason, /字母、数字/);
  assert.match(issues[2].reason, /重复/); // 大小写不敏感去重
  assert.match(issues[3].reason, /6~200/);
  assert.equal(issues[3].row, 6);
});

test("账号导入：角色写非法值报错，英文角色名兼容", () => {
  const { parsed, issues } = parseImportRows([
    ["stu004", "", "teacher", ""],
    ["stu005", "", "管理员", ""]
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].role, "TEACHER");
  assert.equal(issues.length, 1);
  assert.match(issues[0].reason, /学生|教师/);
});

test("账号导入：模板自带的示例行自动跳过，不创建账号", () => {
  const { parsed, issues } = parseImportRows([
    ["20260001", "张三", "学生", "zs123456"],   // 模板示例行
    ["stu700", "", "", ""]                        // 正常行
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].email, "stu700");
  assert.equal(issues.length, 0);
});

test("账号导入：数字单元格（学号为数字）按字符串处理", () => {
  const { parsed, issues } = parseImportRows([[20260101, "王五", "", ""]]);
  assert.equal(issues.length, 0);
  assert.equal(parsed[0].email, "20260101");
});
