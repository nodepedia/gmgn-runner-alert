module.exports = {
  apps: [
    {
      name: "gmgn-runner-alert",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      time: true,
      merge_logs: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
