import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 默认只监听本机：把它开成 0.0.0.0 会让同一 WiFi 下的人直接打开这个无登录的开发服务器
    host: 'localhost',
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' },
  },
})
