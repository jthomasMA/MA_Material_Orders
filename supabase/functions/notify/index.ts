// Supabase Edge Function: "notify"
// Sends phone/browser push notifications.
//   type "new_order"     → notifies every admin's devices   (called by the app after an order is submitted)
//   type "status_change" → notifies the person who placed the order (called when an admin changes status)
//   type "test"          → sends a test to the caller's own devices
//
// Required secrets (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (e.g. mailto:you@company.com)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const orderNo = (id: number) => 'MR-' + String(id).padStart(5, '0');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // Who is calling?
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'Not signed in' }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { type, order_id } = await req.json();

    const { data: caller } = await db.from('profiles').select('role, full_name').eq('id', user.id).single();
    const callerIsAdmin = caller?.role === 'admin';

    let recipients: string[] = [];
    let payload: Record<string, string> = {};

    if (type === 'test') {
      recipients = [user.id];
      payload = { title: 'Field Orders', body: 'Test notification — you’re all set ✅', url: './#/settings' };
    } else {
      const { data: order, error } = await db
        .from('orders')
        .select('id, status, priority, requested_by, created_at, jobsite:jobsites(name, job_number), requester:profiles(full_name, email), order_items(count)')
        .eq('id', order_id)
        .single();
      if (error || !order) return json({ error: 'Order not found' }, 404);

      // deno-lint-ignore no-explicit-any
      const o: any = order;
      const job = [o.jobsite?.job_number, o.jobsite?.name].filter(Boolean).join(' ');
      const count = o.order_items?.[0]?.count ?? 0;
      const who = o.requester?.full_name || o.requester?.email || 'Someone';

      if (type === 'new_order') {
        if (o.requested_by !== user.id) return json({ error: 'Not your order' }, 403);
        if (Date.now() - new Date(o.created_at).getTime() > 15 * 60 * 1000) return json({ skipped: 'old order' });
        const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin');
        recipients = (admins ?? []).map((a) => a.id).filter((id) => id !== user.id);
        payload = {
          title: `${o.priority === 'Urgent' ? '🚨 URGENT ' : ''}New order ${orderNo(o.id)}`,
          body: `${who} · ${job} · ${count} item${count === 1 ? '' : 's'}`,
          url: `./#/order/${o.id}`,
          tag: `order-${o.id}`,
        };
      } else if (type === 'status_change') {
        if (!callerIsAdmin) return json({ error: 'Admins only' }, 403);
        if (o.requested_by === user.id) return json({ skipped: 'own order' });
        recipients = [o.requested_by];
        payload = {
          title: `Order ${orderNo(o.id)}: ${o.status}`,
          body: `${job}${caller?.full_name ? ` · updated by ${caller.full_name}` : ''}`,
          url: `./#/order/${o.id}`,
          tag: `order-${o.id}`,
        };
      } else {
        return json({ error: 'Unknown type' }, 400);
      }
    }

    if (!recipients.length) return json({ sent: 0 });

    const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', recipients);
    let sent = 0;
    await Promise.all((subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 24 },
        );
        sent++;
      } catch (err) {
        // deno-lint-ignore no-explicit-any
        const code = (err as any)?.statusCode;
        if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // device gone
        else console.error('push failed', code, err);
      }
    }));

    return json({ sent });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
