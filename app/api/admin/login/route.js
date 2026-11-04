import { NextResponse } from 'next/server';
import { loginAdmin } from '@/lib/portal-auth';
import {
  getClientIp,
  checkLoginRateLimit,
  recordFailedLogin,
  resetLoginRateLimit,
} from '@/lib/rate-limiter';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export async function POST(request) {
  try {
    const clientIp = getClientIp(request);
    const limitKey = `admin_login:${clientIp}`;

    const attempt = checkLoginRateLimit(limitKey, MAX_ATTEMPTS, WINDOW_MS);
    if (!attempt.allowed) {
      return NextResponse.json(
        {
          success: false,
          error:
            'تم حظر المحاولات مؤقتاً بسبب تكرار إدخال بيانات خاطئة. يرجى المحاولة بعد 15 دقيقة.',
          retry_after: attempt.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(attempt.retryAfterSeconds),
          },
        },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'صيغة البيانات غير صحيحة، يرجى إرسال JSON صالح.' },
        { status: 400 },
      );
    }

    const token = loginAdmin(body && body.password);

    if (!token) {
      recordFailedLogin(limitKey, WINDOW_MS);
      return NextResponse.json(
        { success: false, error: 'كلمة مرور البائع غير صحيحة.' },
        { status: 401 },
      );
    }

    resetLoginRateLimit(limitKey);

    return NextResponse.json({
      success: true,
      token,
      role: 'admin',
      expires_in_hours: 8,
    });
  } catch (error) {
    console.error('Unhandled error in admin login:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'حدث خطأ داخلي في الخادم أثناء تسجيل دخول البائع.',
      },
      { status: 500 },
    );
  }
}
