import { defineConfig } from 'vite';
// 相对路径：dist 可以放到任意子目录（例如原站的 /atlas2/）
export default defineConfig({ base: './', build: { chunkSizeWarningLimit: 2000 } });
