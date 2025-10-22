import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  server: {
    port: 5174,
    host: true,
    https: false, // Вимикаємо HTTPS
    headers: {
      'Access-Control-Allow-Origin': 'https://www.owlbear.rodeo',
      'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
    },
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