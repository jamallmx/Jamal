import { createApp } from './src/app.js';

const port = Number(process.env.PORT ?? 3000);
const { app } = createApp({ dataDir: process.env.DATA_DIR ?? 'data' });

app.listen(port, () => console.log(`Mahdar listening on http://localhost:${port}`));
