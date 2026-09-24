// PM2 process file for the VPS (see DEPLOY.md): `pm2 start ecosystem.config.cjs`.
// Both apps listen on localhost only; Nginx is the public entry point.
module.exports = {
  apps: [
    {
      name: "twinstack-api",
      cwd: "./server",
      script: "src/index.js",
      node_args: "--env-file=.env",
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
    },
    {
      name: "twinstack-web",
      cwd: "./client",
      script: "node_modules/next/dist/bin/next",
      args: "start -H 127.0.0.1 -p 3000",
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
    },
  ],
};
