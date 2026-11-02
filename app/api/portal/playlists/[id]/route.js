import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticatePortalRequest } from '@/lib/portal-auth';
import { encryptPassword } from '@/lib/iptv-crypto';

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const device = await authenticatePortalRequest(request);

    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
      );
    }

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'معرف القائمة مطلوب.' },
        { status: 400 },
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'صيغة البيانات غير صحيحة.' },
        { status: 400 },
      );
    }

    const { name, type, url, username, password, is_active } = body;

    const updateFields = {
      updated_at: new Date().toISOString(),
    };

    if (name && typeof name === 'string') {
      updateFields.name = name.trim().slice(0, 100);
    }

    if (type && typeof type === 'string') {
      const cleanType = type.trim().toLowerCase();
      if (cleanType === 'm3u' || cleanType === 'xtream') {
        updateFields.type = cleanType;
      }
    }

    if (url && typeof url === 'string') {
      const cleanUrl = url.trim();
      if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
        updateFields.url = cleanUrl;
      }
    }

    if (username !== undefined) {
      updateFields.username =
        typeof username === 'string' && username.trim()
          ? username.trim()
          : null;
    }

    if (password !== undefined && password !== null && password !== '') {
      updateFields.password = encryptPassword(String(password).trim());
    }

    if (typeof is_active === 'boolean') {
      updateFields.is_active = is_active;
    }

    const { data: updated, error: updateError } = await supabase
      .from('playlists')
      .update(updateFields)
      .eq('id', id)
      .eq('device_id', device.id)
      .select('*')
      .maybeSingle();

    if (updateError || !updated) {
      return NextResponse.json(
        { success: false, error: 'تعذر تعديل القائمة أو أنها غير موجودة.' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'تم تعديل القائمة بنجاح.',
      playlist: {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        url: updated.url,
        username: updated.username,
        is_active: updated.is_active,
        updated_at: updated.updated_at,
      },
    });
  } catch (error) {
    console.error('Unhandled error in update playlist [id]:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ أثناء تعديل القائمة.' },
      { status: 500 },
    );
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const device = await authenticatePortalRequest(request);

    if (!device) {
      return NextResponse.json(
        { success: false, error: 'غير مصرح، يرجى تسجيل الدخول أولاً.' },
        { status: 401 },
      );
    }

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'معرف القائمة مطلوب.' },
        { status: 400 },
      );
    }

    const { error: deleteError } = await supabase
      .from('playlists')
      .delete()
      .eq('id', id)
      .eq('device_id', device.id);

    if (deleteError) {
      console.error('Database error in DELETE playlist [id]:', deleteError);
      return NextResponse.json(
        { success: false, error: 'تعذر حذف القائمة.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'تم حذف القائمة بنجاح.',
    });
  } catch (error) {
    console.error('Unhandled error in DELETE playlist [id]:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ أثناء حذف القائمة.' },
      { status: 500 },
    );
  }
}
