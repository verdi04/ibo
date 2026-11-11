import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticatePortalRequest } from '@/lib/portal-auth';
import { encryptPassword, decryptPassword } from '@/lib/iptv-crypto';
import { resolveAndParsePlaylistInput } from '@/lib/xtream-parser';

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

    const { data: existing, error: findError } = await supabase
      .from('playlists')
      .select('*')
      .eq('id', id)
      .eq('device_id', device.id)
      .maybeSingle();

    if (findError || !existing) {
      return NextResponse.json(
        { success: false, error: 'القائمة غير موجودة أو لا تنتمي لهذا الجهاز.' },
        { status: 404 },
      );
    }

    const { name, type, url, username, password, is_active } = body;

    const updateFields = {
      updated_at: new Date().toISOString(),
    };

    if (name && typeof name === 'string' && name.trim()) {
      updateFields.name = name.trim().slice(0, 100);
    }

    if (typeof is_active === 'boolean') {
      updateFields.is_active = is_active;
    }

    const isUpdatingConnection =
      url !== undefined || type !== undefined || username !== undefined || password !== undefined;

    if (isUpdatingConnection) {
      const requestedType =
        typeof type === 'string' && type.trim()
          ? type.trim().toLowerCase()
          : existing.type;
      const candidateUrl =
        typeof url === 'string' && url.trim() ? url.trim() : existing.url;
      const existingPlainPass = existing.password ? decryptPassword(existing.password) : null;

      const candidateUser =
        requestedType === 'm3u'
          ? null
          : username !== undefined
            ? username
            : existing.username;
      const candidatePass =
        requestedType === 'm3u'
          ? null
          : password !== undefined && password !== null && password !== ''
            ? password
            : existingPlainPass;

      const parsed = await resolveAndParsePlaylistInput({
        url: candidateUrl,
        username: candidateUser,
        password: candidatePass,
      });

      if (requestedType === 'xtream' && !parsed.isXtream) {
        return NextResponse.json(
          {
            success: false,
            error: 'اسم المستخدم وكلمة المرور مطلوبان لحسابات إكستريم (Xtream).',
          },
          { status: 400 },
        );
      }

      updateFields.type = parsed.isXtream ? 'xtream' : 'm3u';
      updateFields.url = parsed.url;
      updateFields.username = parsed.isXtream ? parsed.username : null;
      updateFields.password = parsed.isXtream ? encryptPassword(parsed.password) : null;
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
    console.error('Unhandled error in delete playlist [id]:', error);
    return NextResponse.json(
      { success: false, error: 'حدث خطأ أثناء حذف القائمة.' },
      { status: 500 },
    );
  }
}
