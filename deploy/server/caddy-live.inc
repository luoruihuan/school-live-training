live.example.com {
	reverse_proxy https://127.0.0.1:8443 {
		flush_interval -1
		transport http {
			tls_insecure_skip_verify
			response_header_timeout 30s
		}
	}
}
