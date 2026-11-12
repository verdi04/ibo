'use client';

import { useState, useEffect } from 'react';

export default function AdminPortalPage() {
  const [session, setSession] = useState(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminMac, setAdminMac] = useState('');
  const [adminTarget, setAdminTarget] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem('iptv_admin_session');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.token && parsed.admin) {
          setSession(parsed);
        } else {
          sessionStorage.removeItem('iptv_admin_session');
        }
      }
    } catch (error) {
      console.error('Unable to restore saved admin session:', error);
    }
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = setInterval(tick, 60000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', tick);
    };
  }, []);

  function formatMac(raw) {
    const clean = raw.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 12);
    const parts = clean.match(/.{1,2}/g);
    return parts ? parts.join(':') : clean;
  }

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
        setErrorMessage(data.error || 'فشل تسجيل دخول البائع. تحقق من كلمة المرور.');
        return;
      }

      const newSession = { token: data.token, admin: true };
      setSession(newSession);
      sessionStorage.setItem('iptv_admin_session', JSON.stringify(newSession));
      setSuccessMessage('تم تسجيل دخول البائع بنجاح!');
    } catch (err) {
      setErrorMessage(`تعذر الاتصال بالخادم: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem('iptv_admin_session');
    setSession(null);
    setAdminTarget(null);
    setAdminPassword('');
    setErrorMessage('');
    setSuccessMessage('تم تسجيل الخروج من لوحة البائع.');
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
        setErrorMessage(data.error || 'تعذر جلب بيانات الجهاز. تأكد من عنوان MAC.');
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
        `تم تمديد اشتراك ${data.mac_address} بنجاح! الصلاحية الجديدة: ${data.days_remaining} يوم`
      );
    } catch (err) {
      setErrorMessage(`حدث خطأ أثناء تفعيل الجهاز: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

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

  function getStatusBadge(status) {
    switch (status) {
      case 'active':
        return { bg: '#e6f7ed', color: '#12824c', text: 'مفعل (Active)' };
      case 'trial':
        return { bg: '#eef2ff', color: '#3b5bcc', text: 'تجريبي (Trial)' };
      case 'expired':
      default:
        return { bg: '#fee2e2', color: '#dc2626', text: 'منتهي (Expired)' };
    }
  }

  const inputStyle = {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 48,
    padding: '12px 16px',
    border: '1px solid #d1d5db',
    borderRadius: 12,
    background: '#ffffff',
    color: '#111827',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
  };

  const btnPrimary = {
    padding: '12px 22px',
    background: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
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
              width: 42,
              height: 42,
              borderRadius: 12,
              background: 'linear-gradient(135deg, #1e293b, #0f172a)',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            IBO
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
              لوحة تحكم البائع
            </h1>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
              إدارة اشتراكات الأجهزة وتفعيل الخطط
            </p>
          </div>
        </div>

        {session && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: '#1e293b',
                background: '#f1f5f9',
                padding: '6px 14px',
                borderRadius: 20,
                border: '1px solid #e2e8f0',
              }}
            >
              حساب البائع المفعل
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
      <main style={{ maxWidth: 880, margin: '32px auto', padding: '0 16px' }}>
        {/* Global Notifications */}
        {errorMessage && (
          <div
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

        {!session ? (
          /* View 1: Admin Secret Login Form */
          <div
            style={{
              maxWidth: 440,
              margin: '40px auto',
              background: '#ffffff',
              borderRadius: 20,
              boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.03)',
              border: '1px solid #e2e8f0',
              padding: '36px 30px',
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 14,
                  background: '#f1f5f9',
                  color: '#2563eb',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 24,
                  marginBottom: 12,
                }}
              >
                🔒
              </div>
              <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#0f172a' }}>
                دخول لوحة البائع
              </h2>
              <p style={{ margin: '8px 0 0', fontSize: 13, color: '#64748b', lineHeight: 1.6 }}>
                هذه الصفحة خاصة بالإدارة والمبيعات فقط لتفعيل وتمديد اشتراكات الأجهزة بعد تأكيد الدفع.
              </p>
            </div>

            <form onSubmit={handleAdminLogin} style={{ display: 'grid', gap: 20 }}>
              <div>
                <label
                  htmlFor="admin-password"
                  style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600, color: '#334155' }}
                >
                  كلمة مرور الإدارة / البائع <span style={{ color: '#ef4444' }}>*</span>
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
                  minHeight: 48,
                  opacity: loading ? 0.7 : 1,
                  cursor: loading ? 'wait' : 'pointer',
                }}
              >
                {loading ? 'جارٍ التحقق…' : 'تسجيل الدخول للوحة التحكم'}
              </button>
            </form>
          </div>
        ) : (
          /* View 2: Seller Dashboard */
          <div
            style={{
              background: '#ffffff',
              borderRadius: 20,
              border: '1px solid #e2e8f0',
              padding: '28px 32px',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#0f172a' }}>
              بحث وتفعيل جهاز عميل
            </h2>
            <p style={{ margin: '8px 0 22px', fontSize: 14, color: '#64748b' }}>
              أدخل عنوان MAC الخاص بجهاز العميل للبحث، ثم اختر مدة التمديد المطلوبة بعد تأكيد السداد.
            </p>

            <form
              onSubmit={handleAdminLookup}
              style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <input
                type="text"
                required
                aria-label="عنوان MAC للجهاز"
                placeholder="00:1A:2B:3C:4D:5E"
                value={adminMac}
                onChange={(e) => setAdminMac(formatMac(e.target.value))}
                style={{ ...inputStyle, maxWidth: 300, fontFamily: 'monospace', letterSpacing: '0.08em' }}
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
                  marginTop: 24,
                  border: '1px solid #e2e8f0',
                  borderRadius: 16,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 16,
                    padding: 20,
                    background: '#f8fafc',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>عنوان MAC</div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }} dir="ltr">
                      {adminTarget.mac_address}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>حالة الاشتراك</div>
                    {(() => {
                      const badge = getStatusBadge(licenseState(adminTarget).status);
                      return (
                        <span
                          style={{
                            display: 'inline-block',
                            background: badge.bg,
                            color: badge.color,
                            padding: '4px 12px',
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
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: daysRemaining > 0 ? '#10b981' : '#ef4444',
                          }}
                        >
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
                    padding: '20px',
                    borderTop: '1px solid #e2e8f0',
                    background: '#ffffff',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#475569', marginBottom: 12 }}>
                    اختر مدة التمديد لتفعيل الجهاز فوراً:
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {[12, 6, 3, 1].map((m) => (
                      <button
                        key={m}
                        onClick={() => handleActivate(m)}
                        disabled={loading}
                        style={{
                          ...(m === 12
                            ? btnPrimary
                            : {
                                ...btnPrimary,
                                background: '#f8fafc',
                                color: '#1e293b',
                                border: '1px solid #cbd5e1',
                              }),
                          padding: '11px 18px',
                          fontSize: 14,
                          opacity: loading ? 0.7 : 1,
                        }}
                      >
                        تمديد {m} {m === 1 ? 'شهرًا' : 'أشهرًا'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
