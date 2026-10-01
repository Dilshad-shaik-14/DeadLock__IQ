import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Prevent harmless browser ResizeObserver loop notification warnings from bubbling as uncaught errors
if (typeof window !== 'undefined') {
  const resizeObserverErrRegex = /ResizeObserver loop completed with undelivered notifications|ResizeObserver loop limit exceeded/i;

  window.addEventListener('error', (event) => {
    if (event?.message && resizeObserverErrRegex.test(event.message)) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  });

  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    if (typeof args[0] === 'string' && resizeObserverErrRegex.test(args[0])) {
      return;
    }
    originalConsoleError.apply(console, args);
  };
}

createRoot(document.getElementById('root')!).render(<App />);
