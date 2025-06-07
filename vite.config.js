import { defineConfig } from 'vite';
// import basicSsl from '@vitejs/plugin-basic-ssl'; // <--- ВИДАЛЕНО/ЗАКОМЕНТОВАНО

import fs from 'fs'; // <--- ДОДАНО: Імпорт модуля 'fs' для читання файлів

export default defineConfig({
  plugins: [
    // basicSsl() // <--- ВИДАЛЕНО/ЗАКОМЕНТОВАНО
  ],
  server: {
    port: 5173,
    // !!! ОНОВЛЕНО: Тепер використовуємо сертифікати mkcert напряму !!!
    https: {
      key: fs.readFileSync('./localhost+2-key.pem'), // Шлях до файлу ключа
      cert: fs.readFileSync('./localhost+2.pem'),   // Шлях до файлу сертифіката
    },
    // Заголовки для CORS, дозволяють Owlbear Rodeo отримувати ресурси від Vite
    headers: {
      'Access-Control-Allow-Origin': 'https://www.owlbear.rodeo',
      'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
    },
    // Проксі для перенаправлення запитів з фронтенду на бекенд
    proxy: {
      '/upload-photo': {
        target: 'https://localhost:3000',
        changeOrigin: true, // Змінює заголовок Origin на target URL
        secure: false       // Дозволяє запити до HTTPS-бекенду з самопідписаним сертифікатом
      },
      '/uploads': { // Для доступу до завантажених файлів
        target: 'https://localhost:3000',
        changeOrigin: true,
        secure: false
      },
    },
    // Додаткові налаштування сервера для забезпечення CORS заголовків
    configureServer: (server) => {
      server.middlewares.use((req, res, next) => {
        if (!res.hasHeader('Access-Control-Allow-Origin')) {
          res.setHeader('Access-Control-Allow-Origin', 'https://www.owlbear.rodeo');
          res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
          res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        }
        next();
      });
    }
  },
});