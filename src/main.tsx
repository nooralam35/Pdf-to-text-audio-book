import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initOfflineServiceWorker } from './lib/offlineCache';

initOfflineServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
