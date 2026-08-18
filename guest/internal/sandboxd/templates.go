package sandboxd

import (
	"fmt"
	"net/url"
)

const nginxConfigurationTemplate = `server {
  listen 80;
  client_max_body_size 50m;

  location ~ ^/(graphql|media|thumbnail|static)/ {
    proxy_pass http://api:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto %s;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location / {
    proxy_pass http://dashboard:80;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto %s;
  }
}
`

func nginxConfiguration(job Job) string {
	parsed, _ := url.Parse(job.PrivateURL)
	return fmt.Sprintf(nginxConfigurationTemplate, parsed.Scheme, parsed.Scheme)
}

func composeOverride(job Job) string {
	return fmt.Sprintf(`services:
  api:
    image: saleor-sandbox-core:%s
    environment:
      ALLOWED_HOSTS: "*"
      ALLOWED_CLIENT_HOSTS: "*"
      DASHBOARD_URL: "%s/"
      PUBLIC_URL: "%s"
      HTTP_IP_FILTER_ENABLED: "False"
  worker:
    image: saleor-sandbox-core:%s
  dashboard:
    image: ghcr.io/saleor/saleor-dashboard:%s
    environment:
      API_URL: "/graphql/"
      APP_MOUNT_URI: "/"
  gateway:
    image: nginx:1.29-alpine
    restart: unless-stopped
    depends_on:
      - api
      - dashboard
    ports:
      - "8080:80"
    volumes:
      - ./sandbox.nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - default
      - saleor-backend-tier
networks:
  default: {}
`, job.Commit, job.PrivateURL, job.PrivateURL, job.Commit, job.DashboardTag)
}
