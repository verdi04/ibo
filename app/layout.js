import './globals.css';

export const metadata = {
  title: 'بوابة IPTV | إدارة جهازك وقوائمك',
  description: 'بوابة آمنة لإدارة جهاز IPTV وقوائم التشغيل والاشتراك.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
