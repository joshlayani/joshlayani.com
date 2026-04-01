server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    listen [::]:80;
    server_name joshlayani.com www.joshlayani.com;

    root /var/www/joshlayani.com;
    index index.html;

    location = / {
        try_files /index.html =404;
        add_header Cache-Control "no-cache";
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1h;
        add_header Cache-Control "public, max-age=3600";
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    access_log /var/log/nginx/joshlayani.com.access.log;
    error_log /var/log/nginx/joshlayani.com.error.log;
}
