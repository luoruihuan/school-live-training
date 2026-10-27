import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, App as AntApp, Button, ConfigProvider, Form, Input, Result, Spin } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ArrowRightOutlined, LockOutlined, PlaySquareFilled, UserOutlined } from "@ant-design/icons";
import { api, post, type User } from "./api";

const StudentPortal = lazy(() => import("./StudentPortal"));
const AdminPortal = lazy(() => import("./AdminPortal"));
const adminEntry = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");
const entryPath = adminEntry ? "/admin" : "/";

export function App() {
  return <ConfigProvider locale={zhCN} theme={{ token: {
    colorPrimary: adminEntry ? "#3263dc" : "#176b53", colorInfo: adminEntry ? "#3263dc" : "#176b53",
    borderRadius: adminEntry ? 8 : 12, fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
    colorText: "#202c2b", colorBgLayout: adminEntry ? "#f3f5f9" : "#f7f8f3"
  } }}><AntApp><Session /></AntApp></ConfigProvider>;
}

function Session() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<User>("/auth/me").then(setUser).catch((e: unknown) => {
      if (e instanceof Error && !e.message.includes("登录")) setError(e.message);
    }).finally(() => setLoading(false));
    const expired = () => { setUser(null); setError("登录已失效，请重新登录。"); };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  async function login(values: { email: string; password: string }) {
    setBusy(true); setError("");
    try { setUser(await post<User>("/auth/login", values)); }
    catch (e) { setError(e instanceof Error ? e.message : "登录失败"); }
    finally { setBusy(false); }
  }
  async function logout() {
    try { await post("/auth/logout", {}); setUser(null); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "退出失败"); }
  }
  async function changePassword(values: { currentPassword: string; newPassword: string; confirmPassword: string }) {
    if (values.newPassword !== values.confirmPassword) { setError("两次输入的新密码不一致"); return; }
    setBusy(true); setError("");
    try {
      await post("/auth/change-password", { currentPassword: values.currentPassword, newPassword: values.newPassword });
      setUser(null); setError("密码已修改，请使用新密码重新登录。");
    } catch (e) { setError(e instanceof Error ? e.message : "修改密码失败"); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="loading-screen"><Spin size="large" description="正在进入课堂…" /></div>;
  if (!user) return <main className={`login-screen ${adminEntry ? "login-screen--admin" : ""}`}>
    <section className="login-story">
      <a className="brand" href={entryPath}><PlaySquareFilled /><span>校园直播<span className="brand-sub">CAMPUS LIVE</span></span></a>
      <div className="login-story__copy"><span className="eyebrow">{adminEntry ? "TEACHING CONSOLE" : "LEARN BY DOING"}</span>
        <h1>{adminEntry ? <>让每一堂实训，<br />有序发生。</> : <>把课堂打开，<br />让实践发生。</>}</h1>
        <p>{adminEntry ? "从课堂准备到直播教学，在一个工作台管理日常实训。" : "进入直播课堂，参与交流，在真实的业务流程中练习与成长。"}</p>
      </div>
      <div className="login-orbit" aria-hidden="true"><div><PlaySquareFilled /><span>LIVE CLASSROOM</span></div></div>
      <div className="login-story__foot">观看 · 互动 · 实践 · 回顾</div>
    </section>
    <section className="login-panel"><div className="login-panel__inner">
      <span className="eyebrow">{adminEntry ? "管理入口" : "学生入口"}</span><h2>{adminEntry ? "登录教学工作台" : "欢迎回到课堂"}</h2>
      <p className="muted">使用学校分配的账号登录，开始{adminEntry ? "管理实训" : "今天的学习"}。</p>
      {error && <Alert type="error" title={error} showIcon className="spaced" />}
      <Form layout="vertical" onFinish={login} requiredMark={false} size="large">
        <Form.Item label="账号" name="email" rules={[{ required: true, message: "请输入账号" }]}><Input prefix={<UserOutlined />} autoComplete="username" placeholder="请输入学校分配的账号" maxLength={100} /></Form.Item>
        <Form.Item label="登录密码" name="password" rules={[{ required: true, message: "请输入密码" }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" maxLength={200} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} block icon={<ArrowRightOutlined />}>进入{adminEntry ? "工作台" : "课堂"}</Button>
      </Form>
      <p className="login-help">忘记密码？请联系学校管理员重置。</p>
    </div><span className="login-note">校园直播实训平台 · 积分兑换实训</span></section>
  </main>;
  if (adminEntry ? user.role === "STUDENT" : user.role !== "STUDENT") return <Result status="403" title={adminEntry ? "此入口仅供教师和管理员使用" : "此入口仅供学生使用"} extra={<Button type="primary" onClick={() => void logout()}>退出当前账号</Button>} />;
  if (user.mustChangePassword) return <main className="login-screen"><section className="login-story"><a className="brand" href={entryPath}><PlaySquareFilled /><span>校园直播</span></a><div className="login-story__copy"><h1>首次登录，请设置自己的密码。</h1><p>完成后使用新密码重新登录。</p></div></section><section className="login-panel"><div className="login-panel__inner"><h2>修改初始密码</h2><p className="muted">账号：{user.email}</p>{error && <Alert type="error" title={error} showIcon className="spaced" />}<Form layout="vertical" onFinish={changePassword} requiredMark={false} size="large"><Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}><Input.Password autoComplete="current-password" maxLength={200} /></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 12, message: "至少 12 位" }]}><Input.Password autoComplete="new-password" maxLength={200} /></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={["newPassword"]} rules={[{ required: true, message: "请再次输入新密码" }, ({ getFieldValue }) => ({ validator(_, value) { return value === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次输入不一致")); } })]}><Input.Password autoComplete="new-password" maxLength={200} /></Form.Item><Button type="primary" htmlType="submit" block loading={busy}>保存并重新登录</Button></Form><Button type="link" onClick={() => void logout()}>退出登录</Button></div></section></main>;
  return <>{error && <Alert type="error" title={error} />}<Suspense fallback={<div className="loading-screen"><Spin size="large" /></div>}>
    {adminEntry ? <AdminPortal key={user.id} user={user} logout={logout} /> : <StudentPortal key={user.id} user={user} logout={logout} />}
  </Suspense></>;
}
