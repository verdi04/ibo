import { NextResponse } from 'next/server';
import { decryptPayload } from '@/lib/iptv-crypto';

export async function POST(request) {
  try {
    // Debug-only route: decrypting arbitrary payloads is disabled in production
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { success: false, error: 'This endpoint is available in development only.' },
        { status: 404 },
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

    const payload = body.payload || body;
    if (!payload) {
      return NextResponse.json(
        { success: false, error: 'payload مطلوب لفك التشفير.' },
        { status: 400 },
      );
    }

    const decrypted = decryptPayload(payload);
    return NextResponse.json({
      success: true,
      decrypted,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: `تعذر فك التشفير: ${error.message}`,
      },
      { status: 400 },
    );
  }
}
