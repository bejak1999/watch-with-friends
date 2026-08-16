import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppState';
import { Avatar, Brand, Icon } from './ui';

export function Layout() {
  const { user, siteName, logout } = useApp();
  const [navOpen, setNavOpen] = useState(false);
  // Collapsing the nav is a per-device preference, so it lives in localStorage.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('wwf.navCollapsed') === '1');
  const inRoom = window.location.pathname.startsWith('/rooms/');

  useEffect(() => {
    localStorage.setItem('wwf.navCollapsed', collapsed ? '1' : '0');
  }, [collapsed]);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  if (!user) return null;

  const nav = (
    <nav className="sidebar" data-open={navOpen}>
      <div style={{ padding: '2px 8px 14px' }}>
        <Brand name={siteName} />
      </div>

      <NavLink to="/" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} end>
        <Icon name="home" /> Rooms
      </NavLink>
      <NavLink to="/playlists" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
        <Icon name="list" /> Playlists
      </NavLink>
      <NavLink to="/stats" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
        <Icon name="chart" /> Statistics
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
        <Icon name="settings" /> Settings
      </NavLink>
      {user.isAdmin && (
        <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <Icon name="shield" /> Admin
        </NavLink>
      )}

      <div className="sidebar-footer">
        <div className="row" style={{ gap: 8, padding: '4px 6px' }}>
          <Avatar name={user.displayName} color={user.avatarColor} url={user.avatarUrl} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 600, fontSize: '0.87rem' }}>
              {user.displayName}
            </div>
            <div className="tiny faint truncate">@{user.username}</div>
          </div>
          <button
            className="btn ghost icon sm"
            title="Sign out"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            <Icon name="logout" size={15} />
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className={`app-shell${collapsed ? ' nav-collapsed' : ''}`}>
      {nav}
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      <div className="main">
        <div className="mobile-bar">
          <button className="btn ghost icon" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <Brand name={siteName} />
        </div>
        {/* Desktop: fold the nav away so the video gets the width. */}
        <button
          className="nav-collapse-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Show the menu" : "Hide the menu"}
          aria-label={collapsed ? "Show the menu" : "Hide the menu"}
          data-in-room={inRoom}
        >
          <Icon name="panel-left" size={15} />
        </button>
        <Outlet />
      </div>
    </div>
  );
}
