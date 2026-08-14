import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './state/AppState';
import { Layout } from './components/Layout';
import { Toasts } from './components/Toasts';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { RoomsPage } from './pages/RoomsPage';
import { RoomPage } from './pages/RoomPage';
import { InvitePage } from './pages/InvitePage';
import { PlaylistsPage } from './pages/PlaylistsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminPage } from './pages/AdminPage';

function FullPageSpinner() {
  return (
    <div className="center" style={{ height: '100%' }}>
      <span className="spinner" />
    </div>
  );
}

export function App() {
  const { user, loading } = useApp();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;

  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return (
      <>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<Navigate to={`/login${location.pathname !== '/' ? `?next=${next}` : ''}`} replace />} />
        </Routes>
        <Toasts />
      </>
    );
  }

  return (
    <>
      <Routes>
        {/* The room view manages its own full-height layout. */}
        <Route element={<Layout />}>
          <Route path="/" element={<RoomsPage />} />
          <Route path="/rooms/:roomId" element={<RoomPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {user.isAdmin && <Route path="/admin" element={<AdminPage />} />}
        </Route>
        <Route path="/join/:token" element={<InvitePage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
