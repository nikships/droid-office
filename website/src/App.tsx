import { Landing } from './pages/Landing';

export function App() {
  return (
    <div data-brand="factory" style={{ background: 'var(--bg-void)', color: 'var(--text)', fontFamily: 'var(--font)', minHeight: '100%' }} className="w-full">
      <Landing />
    </div>
  );
}
