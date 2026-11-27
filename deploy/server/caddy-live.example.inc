# 站点反向代理片段：把 live.example.com 换成业务域名，合并进 /etc/caddy/Caddyfile 后执行 caddy reload。
# 含真实域名的 caddy-live.inc 已加入 .gitignore，不要提交。
#
# 上游必须写 https://127.0.0.1:8443，不要写 localhost：
# localhost 会解析出 IPv6（[::1]），而容器端口只监听 IPv4，Caddy 随机拨到 v6 会 connection refused，
# 表现为约一半请求 502、直播卡顿。验证方式：连续请求主站 20 次以上应全部返回 200。
live.example.com {
	reverse_proxy https://127.0.0.1:8443 {
		flush_interval -1
		transport http {
			tls_insecure_skip_verify
			response_header_timeout 30s
		}
	}
}
