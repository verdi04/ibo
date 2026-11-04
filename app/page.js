'use client';

import { useState, useEffect } from 'react';

export default function IboPortal() {
  const [session, setSession] = useState(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('iptv_portal_session');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.token && (parsed.device || parsed.admin)) {
          setSession(parsed);
        } else {
          sessionStorage.removeItem('iptv_portal_session');
        }
      }
    } catch (error) {
      console.error('Unable to restore the saved portal session:', error);
    }
  }, []);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // Login form state
  const [macAddress, setMacAddress] = useState('');
  const [deviceKey, setDeviceKey] = useState('');

  // Dashboard playlists state
  const [playlists, setPlaylists] = useState([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);

  // Seller panel state: the only principal allowed to grant subscription time
  const [loginMode, setLoginMode] = useState('device'); // 'device' | 'admin'
  const [adminPassword, setAdminPassword] = useState('');
  const [adminMac, setAdminMac] = useState('');
  const [adminTarget, setAdminTarget] = useState(null);

  // Modals state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState(null);
  const [playlistType, setPlaylistType] = useState('m3u'); // 'm3u' | 'xtream'

  // Playlist Form State
  const [plName, setPlName] = useState('');
  const [plUrl, setPlUrl] = useState('');
  const [plUsername, setPlUsername] = useState('');
  const [plPassword, setPlPassword] = useState('');

  // Load playlists whenever a device session token changes
  useEffect(() => {
    if (session?.token && session?.device) {
      loadPlaylists(session.token);
    }
  }, [session?.token]);

  // Re-render the subscription counters every minute so a day rollover is reflected
  // without the visitor reloading the page.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, []);

  // A seller can extend this device while its own dashboard is open, so the row is read
  // again on mount and then periodically rather than kept as the login snapshot.
  useEffect(() => {
    const token = session?.token;
    if (!token || !session?.device) return undefined;

    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch('/api/portal/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled || !res.ok || !data.success) return;
        setSession((prev) => {
          if (!prev || !prev.device) return prev;
          const next = { ...prev, device: data.device };
          sessionStorage.setItem('iptv_portal_session', JSON.stringify(next));
          return next;
        });
      } catch (err) {
        console.error('Unable to refresh the subscription status:', err);
      }
    };

    refresh();
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [session?.token]);

  // Format MAC address input automatically
  function formatMac(raw) {
    const clean = raw.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
    const parts = clean.match(/.{1,2}/g);
    return parts ? parts.join(':') : clean;
  }

  function handleMacChange(e) {
    setMacAddress(formatMac(e.target.value));
  }

  // Handle Login
  async function handleLogin(e) {
    e.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');
    setLoading(true);

    try {
      const res = await fetch('/api/portal/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mac_address: macAddress.trim(),
          device_key: deviceKey.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'فشل تسجيل الدخول. يرجى التحقق من البيانات.');
        return;
      }

      const newSession = {
        token: data.token,
        device: data.device,
      };

      setSession(newSession);
      sessionStorage.setItem('iptv_portal_session', JSON.stringify(newSession));
      setSuccessMessage('تم تسجيل الدخول بنجاح!');
      loadPlaylists(data.token);
    } catch (err) {
      setErrorMessage(`تعذر الاتصال بالخادم: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Handle Logout
  function handleLogout() {
    sessionStorage.removeItem('iptv_portal_session');
    setSession(null);
    setPlaylists([]);
    setAdminTarget(null);
    setAdminPassword('');
    setErrorMessage('');
    setSuccessMessage('تم تسجيل الخروج بنجاح.');
  }

  // Fetch Playlists
  async function loadPlaylists(token) {
    setLoadingPlaylists(true);
    try {
      const res = await fetch('/api/portal/playlists', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setPlaylists(data.playlists || []);
      }
    } catch (err) {
      console.error('Failed to load playlists:', err);
    } finally {
      setLoadingPlaylists(false);
    }
  }

  // Regenerate Device Key
  async function handleChangeKey() {
    if (!session) return;
    if (!confirm('هل أنت متأكد من رغبتك في تجديد مفتاح الجهاز السري؟ سيتم إنشاء مفتاح جديد عشوائي.')) {
      return;
    }

    setLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const res = await fetch('/api/device/change-key?plain=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mac_address: session.device.mac_address,
          current_key: session.device.device_key,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'تعذر تجديد مفتاح الجهاز.');
        return;
      }

      const newKey = data.device_key || data.payload?.device_key;
      const updatedSession = {
        ...session,
        device: {
          ...session.device,
          device_key: newKey,
        },
      };

      setSession(updatedSession);
      sessionStorage.setItem('iptv_portal_session', JSON.stringify(updatedSession));
      setDeviceKey(newKey);
      setSuccessMessage(`تم تجديد مفتاح الجهاز بنجاح! المفتاح الجديد هو: ${newKey}`);
    } catch (err) {
      setErrorMessage(`حدث خطأ أثناء تجديد المفتاح: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Seller sign-in: the only session allowed to grant subscription time
  async function handleAdminLogin(e) {
    e.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');
    setLoading(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'فشل تسجيل دخول البائع.');
        return;
      }

      const newSession = { token: data.token, admin: true };
      setSession(newSession);
      sessionStorage.setItem('iptv_portal_session', JSON.stringify(newSession));
      setSuccessMessage('تم تسجيل دخول البائع بنجاح!');
    } catch (err) {
      setErrorMessage(`تعذر الاتصال بالخادم: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdminLookup(e) {
    e.preventDefault();
    if (!session?.admin) return;
    setLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const res = await fetch(`/api/admin/device?mac=${encodeURIComponent(adminMac)}`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setAdminTarget(null);
        setErrorMessage(data.error || 'تعذر جلب بيانات الجهاز.');
        return;
      }

      setAdminTarget(data.device);
    } catch (err) {
      setAdminTarget(null);
      setErrorMessage(`حدث خطأ أثناء جلب بيانات الجهاز: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Extend the looked-up device's subscription
  async function handleActivate(months) {
    if (!session?.admin || !adminTarget) return;
    setLoading(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const res = await fetch('/api/admin/activate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ mac_address: adminTarget.mac_address, months }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'تعذر تفعيل الجهاز.');
        return;
      }

      setAdminTarget((prev) => ({
        ...prev,
        status: data.status,
        license_expires_at: data.license_expires_at,
        days_remaining: data.days_remaining,
        is_valid: true,
      }));
      setSuccessMessage(
        `تم تمديد اشتراك ${data.mac_address}! الصلاحية الجديدة: ${data.days_remaining} يوم`
      );
    } catch (err) {
      setErrorMessage(`حدث خطأ أثناء تفعيل الجهاز: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Open Modal for Add
  function openAddModal() {
    setEditingPlaylist(null);
    setPlName('');
    setPlUrl('');
    setPlUsername('');
    setPlPassword('');
    setPlaylistType('m3u');
    setShowAddModal(true);
  }

  // Open Modal for Edit
  function openEditModal(item) {
    setEditingPlaylist(item);
    setPlName(item.name || '');
    setPlUrl(item.url || '');
    setPlUsername(item.username || '');
    setPlPassword(item.password || '');
    setPlaylistType(item.type || 'm3u');
    setShowAddModal(true);
  }

  // Save (Create or Update) Playlist
  async function handleSavePlaylist(e) {
    e.preventDefault();
    if (!session) return;

    setLoading(true);
    setErrorMessage('');

    try {
      const payload = {
        name: plName.trim(),
        type: playlistType,
        url: plUrl.trim(),
        username: playlistType === 'xtream' ? plUsername.trim() : null,
        password: playlistType === 'xtream' ? plPassword.trim() : null,
      };

      let url = '/api/portal/playlists';
      let method = 'POST';

      if (editingPlaylist) {
        url = `/api/portal/playlists/${editingPlaylist.id}`;
        method = 'PUT';
      }

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'تعذر حفظ قائمة التشغيل.');
        return;
      }

      setShowAddModal(false);
      setSuccessMessage(editingPlaylist ? 'تم تحديث القائمة بنجاح!' : 'تمت إضافة القائمة بنجاح!');
      loadPlaylists(session.token);
    } catch (err) {
      setErrorMessage(`حدث خطأ أثناء حفظ القائمة: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Delete Playlist
  async function handleDeletePlaylist(id) {
    if (!session) return;
    if (!confirm('هل أنت متأكد من حذف هذه القائمة نهائياً؟')) {
      return;
    }

    setLoading(true);
    setErrorMessage('');

    try {
      const res = await fetch(`/api/portal/playlists/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMessage(data.error || 'تعذر حذف القائمة.');
        return;
      }

      setSuccessMessage('تم حذف قائمة التشغيل بنجاح.');
      loadPlaylists(session.token);
    } catch (err) {
      setErrorMessage(`حدث خطأ أثناء حذف القائمة: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Toggle Playlist Active Status
  async function handleToggleStatus(item) {
    if (!session) return;
    try {
      const res = await fetch(`/api/portal/playlists/${item.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ is_active: !item.is_active }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        loadPlaylists(session.token);
      }
    } catch (err) {
      console.error('Failed to toggle status:', err);
    }
  }

  // Mirrors lib/device-status.js so the counters follow the absolute expiry timestamps
  // instead of the days_remaining value returned when the session was created.
  function licenseState(row) {
    if (!row) return { status: 'expired', daysRemaining: 0 };

    const licenseExp = row.license_expires_at
      ? new Date(row.license_expires_at).getTime()
      : null;
    const trialExp = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
    const dayMs = 1000 * 60 * 60 * 24;

    if (licenseExp && licenseExp > now) {
      return {
        status: 'active',
        daysRemaining: Math.max(0, Math.ceil((licenseExp - now) / dayMs)),
      };
    }
    if (trialExp && trialExp > now) {
      return {
        status: 'trial',
        daysRemaining: Math.max(0, Math.ceil((trialExp - now) / dayMs)),
      };
    }
    return { status: 'expired', daysRemaining: 0 };
  }

  function formatLocalDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  // Helpers for Status Styles & Badges
  function getStatusBadge(status) {
    switch (status) {
      case 'active':
        return {
          bg: '#e6f7ed',
          color: '#12824c',
          text: 'مفعل (Active)',
        };
      case 'trial':
        return {
          bg: '#eef2ff',
          color: '#3b5bcc',
          text: 'تجريبي (Trial)',
        };
      case 'expired':
      default:
        return {
          bg: '#fee2e2',
          color: '#dc2626',
          text: 'منتهي (Expired)',
        };
    }
  }

  const inputStyle = {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 46,
    padding: '12px 14px',
    border: '1px solid #d1d5db',
    borderRadius: 10,
    background: '#ffffff',
    color: '#111827',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
  };

  const btnPrimary = {
    padding: '11px 20px',
    background: '#3b82f6',
    color: '#ffffff',
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.2s',
  };

  return (
    <div
      className="portal-app"
      dir="rtl"
      style={{
        minHeight: '100vh',
        background: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#1e293b',
        paddingBottom: 60,
      }}
    >
      {/* Top Navbar */}
      <header
        style={{
          background: '#ffffff',
          borderBottom: '1px solid #e2e8f0',
          padding: '16px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 20,
            }}
          >
            IBO
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                بوابة IPTV
            </h1>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
              إدارة جهازك وقوائمك في مكان واحد
            </p>
          </div>
        </div>

        {session && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#475569',
                background: '#f1f5f9',
                padding: '6px 12px',
                borderRadius: 20,
              }}
            >
              {session.admin ? 'حساب البائع' : `الماك: ${session.device.mac_address}`}
            </span>
            <button
              onClick={handleLogout}
              style={{
                background: '#fee2e2',
                color: '#b91c1c',
                border: 'none',
                padding: '8px 14px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              تسجيل الخروج
            </button>
          </div>
        )}
      </header>

      {/* Main Container */}
      <main className="portal-main" style={{ maxWidth: 1000, margin: '32px auto', padding: '0 16px' }}>
        {/* Global Notifications */}
        {errorMessage && (
          <div
            className="portal-notice portal-notice-error"
            style={{
              background: '#fef2f2',
              color: '#b91c1c',
              border: '1px solid #fecaca',
              borderRadius: 12,
              padding: '14px 18px',
              marginBottom: 20,
              fontSize: 14,
              fontWeight: 500,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{errorMessage}</span>
            <button
              onClick={() => setErrorMessage('')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#b91c1c', fontSize: 18 }}
            >
              ×
            </button>
          </div>
        )}

        {successMessage && (
          <div
            className="portal-notice portal-notice-success"
            style={{
              background: '#f0fdf4',
              color: '#15803d',
              border: '1px solid #bbf7d0',
              borderRadius: 12,
              padding: '14px 18px',
              marginBottom: 20,
              fontSize: 14,
              fontWeight: 500,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{successMessage}</span>
            <button
              onClick={() => setSuccessMessage('')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#15803d', fontSize: 18 }}
            >
              ×
            </button>
          </div>
        )}

        {/* View 1: Login Form (If not authenticated) */}
        {!session ? (
          <div className="portal-login-layout">
            <div
              className="portal-login-card"
              style={{
                maxWidth: 460,
                margin: '40px auto',
                background: '#ffffff',
                borderRadius: 16,
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.03)',
                border: '1px solid #e2e8f0',
                padding: '32px 28px',
              }}
            >
            <div style={{ display: 'flex', gap: 8, marginBottom: 22, background: '#f1f5f9', borderRadius: 12, padding: 4 }}>
              {[
                { id: 'device', label: 'دخول الجهاز' },
                { id: 'admin', label: 'دخول البائع' },
              ].map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    setLoginMode(mode.id);
                    setErrorMessage('');
                    setSuccessMessage('');
                  }}
                  style={{
                    flex: 1,
                    padding: '9px 12px',
                    borderRadius: 9,
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: loginMode === mode.id ? '#ffffff' : 'transparent',
                    color: loginMode === mode.id ? '#0f172a' : '#64748b',
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="login-heading" style={{ textAlign: 'center', marginBottom: 28 }}>
              <span className="login-eyebrow">
                {loginMode === 'admin' ? 'صلاحيات البائع' : 'مرحباً بعودتك'}
              </span>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>
                {loginMode === 'admin' ? 'تسجيل دخول البائع' : 'سجّل دخول جهازك'}
              </h2>
              <p style={{ margin: '8px 0 0', fontSize: 14, color: '#64748b' }}>
                {loginMode === 'admin'
                  ? 'من هذه اللوحة فقط يمكن منح الاشتراكات أو تمديدها بعد تأكيد الدفع'
                  : 'أدخل بيانات الجهاز الظاهرة على شاشة التلفاز للمتابعة'}
              </p>
            </div>

            {loginMode === 'admin' ? (
              <form onSubmit={handleAdminLogin} style={{ display: 'grid', gap: 20 }}>
                <div>
                  <label htmlFor="admin-password" style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
                    كلمة مرور البائع <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="password"
                    id="admin-password"
                    required
                    placeholder="••••••••"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    style={inputStyle}
                    autoComplete="off"
                    dir="ltr"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    ...btnPrimary,
                    width: '100%',
                    minHeight: 48,
                    marginTop: 8,
                    opacity: loading ? 0.7 : 1,
                    cursor: loading ? 'wait' : 'pointer',
                  }}
                >
                  {loading ? 'جارٍ التحقق…' : 'دخول لوحة البائع'}
                </button>
              </form>
            ) : (
            <form onSubmit={handleLogin} style={{ display: 'grid', gap: 20 }}>
              <div>
                <label htmlFor="mac-address" style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
                  عنوان الجهاز (MAC Address) <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="text"
                  id="mac-address"
                  required
                  placeholder="00:1A:2B:3C:4D:5E"
                  value={macAddress}
                  onChange={handleMacChange}
                  style={inputStyle}
                  autoComplete="off"
                  dir="ltr"
                />
              </div>

              <div>
                <label htmlFor="device-key" style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
                  رمز الدخول (Device Key) <span style={{ color: '#ef4444' }}>*</span>
                </label>
                <input
                  type="password"
                  id="device-key"
                  required
                  maxLength={6}
                  placeholder="6 أرقام (مثال: 728194)"
                  value={deviceKey}
                  onChange={(e) => setDeviceKey(e.target.value.replace(/\D/g, ''))}
                  style={inputStyle}
                  autoComplete="off"
                  dir="ltr"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                style={{
                  ...btnPrimary,
                  width: '100%',
                  minHeight: 48,
                  marginTop: 8,
                  opacity: loading ? 0.7 : 1,
                  cursor: loading ? 'wait' : 'pointer',
                }}
              >
                {loading ? 'جارٍ التحقق من الجهاز…' : 'دخول آمن إلى حسابك'}
              </button>
            </form>
            )}

            <div
              className="login-security"
              style={{
                marginTop: 24,
                padding: '12px 16px',
                background: '#f8fafc',
                borderRadius: 10,
                fontSize: 13,
                color: '#64748b',
                lineHeight: 1.6,
              }}
            >
              <span className="security-icon" aria-hidden="true">✓</span>
              <span><strong>خصوصيتك أولويتنا</strong><br />بياناتك محمية واتصالك مشفّر في كل خطوة.</span>
            </div>
          </div>
          <aside className="login-hero">
            <div className="hero-orbit hero-orbit-one" />
            <div className="hero-orbit hero-orbit-two" />
            <div className="hero-topline">
              <span className="hero-live-dot" />
              <span>كل ما تحبّه، في مكان واحد</span>
            </div>
            <div className="hero-copy">
              <span className="hero-kicker">بوابتك إلى ترفيه بلا حدود</span>
              <h2>مشاهدة أسهل.<br /><span>وتحكّم أذكى.</span></h2>
              <p>أدِر جهازك وقوائمك المفضّلة بأمان، واستمتع بتجربة مشاهدة سلسة على شاشتك.</p>
            </div>
            <div className="hero-screen" aria-hidden="true">
              <div className="hero-screen-bar"><span /><span /><span /><i>LIVE</i></div>
              <div className="hero-screen-content">
                <div className="hero-feature-card"><span>تجربتك، بطريقتك</span><strong>جاهز للمشاهدة</strong></div>
                <div className="hero-mini-card hero-mini-one" />
                <div className="hero-mini-card hero-mini-two" />
                <div className="hero-mini-card hero-mini-three" />
              </div>
              <div className="hero-screen-stand" />
            </div>
            <div className="hero-benefits">
              <span><b>01</b> إعداد سريع</span>
              <span><b>02</b> إدارة سهلة</span>
              <span><b>03</b> اتصال آمن</span>
            </div>
          </aside>
        </div>
        ) : session.admin ? (
          /* View 2: Seller panel - the only place subscription time can be granted */
          <div
            style={{
              background: '#ffffff',
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              padding: '24px 28px',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>لوحة البائع</h2>
            <p style={{ margin: '8px 0 20px', fontSize: 14, color: '#64748b' }}>
              ابحث بجهاز العميل ثم اختر مدة التمديد بعد تأكيد الدفعة. مفتاح الجهاز لا يمنح اشتراكًا.
            </p>

            <form
              onSubmit={handleAdminLookup}
              style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <input
                type="text"
                required
                aria-label="عنوان MAC للجهاز"
                placeholder="00:1A:2B:3C:4D:5E"
                value={adminMac}
                onChange={(e) => setAdminMac(formatMac(e.target.value))}
                style={{ ...inputStyle, maxWidth: 260, fontFamily: 'monospace' }}
                dir="ltr"
              />
              <button
                type="submit"
                disabled={loading}
                style={{ ...btnPrimary, opacity: loading ? 0.7 : 1 }}
              >
                {loading ? 'جارٍ البحث…' : 'بحث عن الجهاز'}
              </button>
            </form>

            {adminTarget && (
              <div
                style={{
                  marginTop: 20,
                  border: '1px solid #e2e8f0',
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                    gap: 14,
                    padding: 18,
                    background: '#f8fafc',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>MAC</div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: 'monospace' }} dir="ltr">
                      {adminTarget.mac_address}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>الحالة</div>
                    {(() => {
                      const badge = getStatusBadge(licenseState(adminTarget).status);
                      return (
                        <span
                          style={{
                            display: 'inline-block',
                            background: badge.bg,
                            color: badge.color,
                            padding: '4px 10px',
                            borderRadius: 20,
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          {badge.text}
                        </span>
                      );
                    })()}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>الأيام المتبقية</div>
                    {(() => {
                      const { daysRemaining } = licenseState(adminTarget);
                      return (
                        <div style={{ fontSize: 18, fontWeight: 700, color: daysRemaining > 0 ? '#10b981' : '#ef4444' }}>
                          {daysRemaining} يوم
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>انتهاء الترخيص</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>
                      {formatLocalDate(adminTarget.license_expires_at)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>القوائم النشطة</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>
                      {adminTarget.playlists_active} / {adminTarget.playlists_total}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>آخر ظهور للجهاز</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>
                      {formatLocalDate(adminTarget.last_seen_at)}
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: 16,
                    borderTop: '1px solid #e2e8f0',
                  }}
                >
                  {[12, 6, 3, 1].map((m) => (
                    <button
                      key={m}
                      onClick={() => handleActivate(m)}
                      disabled={loading}
                      style={{
                        ...(m === 12 ? btnPrimary : { ...btnPrimary, background: '#f1f5f9', color: '#1e293b', border: '1px solid #cbd5e1' }),
                        padding: '10px 16px',
                        fontSize: 14,
                        opacity: loading ? 0.7 : 1,
                      }}
                    >
                      تمديد {m} {m === 1 ? 'شهرًا' : 'أشهرًا'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* View 2: Authenticated Dashboard */
          <div className="portal-dashboard">
            {/* Device Information Card */}
            <div
              style={{
                background: '#ffffff',
                borderRadius: 16,
                border: '1px solid #e2e8f0',
                padding: '24px 28px',
                marginBottom: 28,
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: 16,
                  borderBottom: '1px solid #f1f5f9',
                  paddingBottom: 20,
                  marginBottom: 20,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
                      بيانات الجهاز المشترك
                    </h2>
                    {(() => {
                      const badge = getStatusBadge(licenseState(session.device).status);
                      return (
                        <span
                          style={{
                            background: badge.bg,
                            color: badge.color,
                            padding: '4px 10px',
                            borderRadius: 16,
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {badge.text}
                        </span>
                      );
                    })()}
                  </div>
                  <p style={{ margin: '6px 0 0', fontSize: 13, color: '#64748b' }}>
                    نوع الجهاز: {session.device.device_type || 'Android TV'}
                  </p>
                </div>

                {/* Quick Action Buttons */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={handleChangeKey}
                    style={{
                      background: '#f1f5f9',
                      color: '#334155',
                      border: '1px solid #cbd5e1',
                      padding: '9px 16px',
                      borderRadius: 10,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    🔄 تجديد مفتاح الجهاز
                  </button>
                </div>
              </div>

              {/* Stats Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 16,
                }}
              >
                <div style={{ background: '#f8fafc', padding: '14px 18px', borderRadius: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>عنوان MAC</div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>
                    {session.device.mac_address}
                  </div>
                </div>

                <div style={{ background: '#f8fafc', padding: '14px 18px', borderRadius: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>مفتاح الجهاز (Device Key)</div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace', color: '#2563eb' }}>
                    {session.device.device_key}
                  </div>
                </div>

                <div style={{ background: '#f8fafc', padding: '14px 18px', borderRadius: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>الأيام المتبقية</div>
                  {(() => {
                    const { daysRemaining } = licenseState(session.device);
                    return (
                      <div style={{ fontSize: 18, fontWeight: 700, color: daysRemaining > 0 ? '#10b981' : '#ef4444' }}>
                        {daysRemaining} يوم
                      </div>
                    );
                  })()}
                </div>

                <div style={{ background: '#f8fafc', padding: '14px 18px', borderRadius: 12 }}>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>تاريخ الانتهاء</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {session.device.license_expires_at
                      ? formatLocalDate(session.device.license_expires_at)
                      : session.device.trial_ends_at
                      ? `تجربة: ${formatLocalDate(session.device.trial_ends_at)}`
                      : 'منتهي'}
                  </div>
                </div>
              </div>
            </div>

            {/* Playlists Section */}
            <div
              style={{
                background: '#ffffff',
                borderRadius: 16,
                border: '1px solid #e2e8f0',
                padding: '24px 28px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 20,
                  flexWrap: 'wrap',
                  gap: 12,
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                    قوائم التشغيل المرتبطة ({playlists.length})
                  </h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
                    يمكنك إضافة روابط M3U أو حسابات إكستريم (Xtream Codes) التي ستظهر على جهاز التلفاز.
                  </p>
                </div>

                <button onClick={openAddModal} style={btnPrimary}>
                  + إضافة قائمة جديدة
                </button>
              </div>

              {/* Playlists Table / List */}
              {loadingPlaylists ? (
                <div style={{ padding: '30px 0', textAlign: 'center', color: '#64748b' }}>
                  جارٍ تحميل قوائم التشغيل…
                </div>
              ) : playlists.length === 0 ? (
                <div
                  style={{
                    padding: '48px 24px',
                    textAlign: 'center',
                    background: '#f8fafc',
                    borderRadius: 12,
                    border: '1px dashed #cbd5e1',
                  }}
                >
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📺</div>
                  <h4 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#334155' }}>
                    لا توجد قوائم تشغيل مضافة بعد
                  </h4>
                  <p style={{ margin: '8px 0 16px', fontSize: 14, color: '#64748b' }}>
                    انقر على الزر أدناه لإضافة أول باقة M3U أو حساب Xtream لهذا الجهاز.
                  </p>
                  <button onClick={openAddModal} style={btnPrimary}>
                    + إضافة قائمة تشغيل
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 14 }}>
                  {playlists.map((pl) => (
                    <div
                      key={pl.id}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 12,
                        padding: '16px 20px',
                        borderRadius: 12,
                        border: '1px solid #e2e8f0',
                        background: pl.is_active ? '#ffffff' : '#f8fafc',
                        opacity: pl.is_active ? 1 : 0.7,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <span
                          style={{
                            background: pl.type === 'xtream' ? '#fef3c7' : '#e0e7ff',
                            color: pl.type === 'xtream' ? '#b45309' : '#3730a3',
                            padding: '4px 10px',
                            borderRadius: 8,
                            fontSize: 12,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                          }}
                        >
                          {pl.type}
                        </span>

                        <div>
                          <div style={{ fontWeight: 700, fontSize: 16, color: '#0f172a' }}>
                            {pl.name}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: '#64748b',
                              maxWidth: 380,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              direction: 'ltr',
                              textAlign: 'right',
                            }}
                          >
                            {pl.url}
                          </div>
                          {pl.username && (
                            <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                              المستخدم: <strong>{pl.username}</strong>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button
                          onClick={() => handleToggleStatus(pl)}
                          style={{
                            background: pl.is_active ? '#f0fdf4' : '#f1f5f9',
                            color: pl.is_active ? '#15803d' : '#64748b',
                            border: '1px solid #cbd5e1',
                            borderRadius: 8,
                            padding: '6px 12px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {pl.is_active ? 'نشطة ✓' : 'معطلة ✗'}
                        </button>

                        <button
                          onClick={() => openEditModal(pl)}
                          style={{
                            background: '#f8fafc',
                            color: '#2563eb',
                            border: '1px solid #cbd5e1',
                            borderRadius: 8,
                            padding: '6px 12px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          تعديل
                        </button>

                        <button
                          onClick={() => handleDeletePlaylist(pl.id)}
                          style={{
                            background: '#fef2f2',
                            color: '#b91c1c',
                            border: '1px solid #fecaca',
                            borderRadius: 8,
                            padding: '6px 12px',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal: Add or Edit Playlist */}
        {showAddModal && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 100,
              padding: 16,
            }}
          >
            <div
              style={{
                background: '#ffffff',
                borderRadius: 16,
                maxWidth: 520,
                width: '100%',
                padding: '28px 24px',
                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 20,
                }}
              >
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
                  {editingPlaylist ? 'تعديل قائمة التشغيل' : 'إضافة قائمة تشغيل جديدة'}
                </h3>
                <button
                  onClick={() => setShowAddModal(false)}
                  style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}
                >
                  ✕
                </button>
              </div>

              {/* Type Switcher */}
              {!editingPlaylist && (
                <div
                  style={{
                    display: 'flex',
                    background: '#f1f5f9',
                    borderRadius: 10,
                    padding: 4,
                    marginBottom: 20,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setPlaylistType('m3u')}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: 'none',
                      background: playlistType === 'm3u' ? '#ffffff' : 'transparent',
                      color: playlistType === 'm3u' ? '#2563eb' : '#64748b',
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: playlistType === 'm3u' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    }}
                  >
                    رابط M3U
                  </button>

                  <button
                    type="button"
                    onClick={() => setPlaylistType('xtream')}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: 'none',
                      background: playlistType === 'xtream' ? '#ffffff' : 'transparent',
                      color: playlistType === 'xtream' ? '#2563eb' : '#64748b',
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: playlistType === 'xtream' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                    }}
                  >
                    حساب إكستريم (Xtream)
                  </button>
                </div>
              )}

              <form onSubmit={handleSavePlaylist} style={{ display: 'grid', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 14, fontWeight: 600 }}>
                    اسم الباقة / القائمة <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="مثال: باقة القنوات العربية الرياضية"
                    value={plName}
                    onChange={(e) => setPlName(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 14, fontWeight: 600 }}>
                    {playlistType === 'm3u' ? 'رابط ملف M3U' : 'رابط السيرفر (Server URL)'}{' '}
                    <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="url"
                    required
                    placeholder={
                      playlistType === 'm3u'
                        ? 'http://example.com/playlist.m3u'
                        : 'http://example.com:8080'
                    }
                    value={plUrl}
                    onChange={(e) => setPlUrl(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                {playlistType === 'xtream' && (
                  <>
                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontSize: 14, fontWeight: 600 }}>
                        اسم المستخدم (Username) <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="text"
                        required
                        placeholder="اسم المستخدم"
                        value={plUsername}
                        onChange={(e) => setPlUsername(e.target.value)}
                        style={inputStyle}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', marginBottom: 6, fontSize: 14, fontWeight: 600 }}>
                        كلمة المرور (Password) <span style={{ color: '#ef4444' }}>*</span>
                      </label>
                      <input
                        type="password"
                        required={!editingPlaylist}
                        placeholder={editingPlaylist ? 'اتركه فارغاً للإبقاء على الحالية' : 'كلمة المرور'}
                        value={plPassword}
                        onChange={(e) => setPlPassword(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                  <button type="submit" disabled={loading} style={{ ...btnPrimary, flex: 1, minHeight: 46 }}>
                    {loading ? 'جارٍ الحفظ…' : 'حفظ القائمة'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAddModal(false)}
                    style={{
                      background: '#f1f5f9',
                      color: '#475569',
                      border: 'none',
                      borderRadius: 10,
                      padding: '11px 20px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    إلغاء
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </main>
      <footer className="portal-footer">
        <span>IPTV Portal</span>
        <span>تجربة مشاهدة متكاملة، وإدارة أسهل لجهازك.</span>
        <span><i className="footer-status-dot" /> اتصال آمن ومشفّر</span>
      </footer>
    </div>
  );
}
