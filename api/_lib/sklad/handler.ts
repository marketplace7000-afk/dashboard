/**
 * /api/sklad/* — раздел «Склад» (этап 1: справочники и пользователи).
 *
 *   GET  bootstrap                 — всё для экрана одним запросом (по правам роли)
 *   GET  products/:id              — карточка + история изменений
 *   POST products                  — новый товар
 *   POST products/:id              — изменить товар
 *   GET  find?q=                   — товар по артикулу или баркоду (сканер)
 *   POST warehouses[/:id]          — склад
 *   POST mp-warehouses[/:id]       — склад площадки; POST mp-warehouses/:id/delete
 *   POST users[/:id]               — пользователь (только владелец)
 *   POST import { dryRun }         — импорт товаров из Google-таблицы
 *   POST mp-sync                   — сверка со складами и карточками WB/Ozon
 *   GET  audit?entity=&id=         — журнал действий
 *
 * Права проверяются здесь, по роли из сессии; фронт только прячет кнопки.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { SkladDbUnavailable, getSkladDb, kvGet, kvSet } from './db';
import { listOrders } from './orders';
import { ROLES, ROLE_LABEL, ROLE_SECTIONS, SECTIONS, SECTION_LABEL, canSeeMoney, createUser, listUsers, updateUser, type AuthUser, type Role } from './users';
import { KIND_INFO, canPostKind, getMovement, listMovements, postMovement, receiveTransfer, reverseMovement, sendTransfer, stockSnapshot, type MovementKind } from './movements';
import { createInventory, finishInventory, getInventory, listInventories, setCount, updateInventory } from './inventory';
import {
  ensureSeed, listWarehouses, listMpWarehouses, saveWarehouse, saveMpWarehouse, deleteMpWarehouse,
  listProducts, getProduct, saveProduct, findProduct, PRODUCT_STATUSES, MP_CODES, HEAVY_WEIGHT_G,
} from './catalog';
import { listAudit } from './audit';

function body(req: VercelRequest): any {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
}

function allow(res: VercelResponse, user: AuthUser, roles: Role[]): boolean {
  if (roles.includes(user.role)) return true;
  res.status(403).json({ error: 'forbidden', reason: 'Недостаточно прав для этого действия' });
  return false;
}

const idOf = (s: string | undefined): number | null => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function result(res: VercelResponse, r: { error?: string } & Record<string, unknown>) {
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  return res.status(200).json({ ok: true, ...r });
}

export async function handleSklad(req: VercelRequest, res: VercelResponse, rest: string[], user: AuthUser) {
  try {
    getSkladDb();
    ensureSeed();
  } catch (e) {
    const msg = e instanceof SkladDbUnavailable ? e.message : String((e as Error)?.message ?? e);
    return res.status(503).json({ ok: false, error: `База склада недоступна: ${msg.slice(0, 200)}` });
  }

  const [what, a, b] = rest;
  const post = req.method === 'POST';
  const whScope = user.role === 'warehouse' ? user.warehouseIds ?? [] : null;

  try {
    if (what === 'bootstrap' && !post) {
      return res.status(200).json({
        ok: true,
        me: { id: user.id, name: user.name, login: user.login, role: user.role, warehouseIds: user.warehouseIds, sections: user.sections },
        warehouses: listWarehouses(whScope),
        mpWarehouses: listMpWarehouses(whScope),
        products: listProducts(),
        users: user.role === 'owner' ? listUsers() : [],
        dict: {
          roles: ROLES.map(r => ({ value: r, label: ROLE_LABEL[r], sections: ROLE_SECTIONS[r] })),
          sections: SECTIONS.map(s => ({ value: s, label: SECTION_LABEL[s] })),
          productStatuses: PRODUCT_STATUSES, mps: MP_CODES, heavyWeightG: HEAVY_WEIGHT_G,
          sheetConfigured: !!(process.env.SKLAD_SHEET_ID || '').trim(),
          kinds: Object.entries(KIND_INFO).map(([k, v]) => ({ value: k, label: v.label, sign: v.sign, canPost: canPostKind(user, k as MovementKind) })),
        },
      });
    }

    if (what === 'products') {
      const id = idOf(a);
      if (!post) {
        if (!id) return res.status(200).json({ ok: true, products: listProducts() });
        const product = getProduct(id);
        if (!product) return res.status(404).json({ ok: false, error: 'Товар не найден' });
        return res.status(200).json({ ok: true, product, audit: listAudit({ entity: 'product', entityId: String(id), limit: 50 }) });
      }
      if (!id && !allow(res, user, ['owner', 'manager', 'buyer'])) return;
      return result(res, saveProduct(id, body(req), user));
    }

    if (what === 'find' && !post) {
      const q = String(req.query.q ?? '').trim();
      if (!q) return res.status(400).json({ ok: false, error: 'Пустой запрос' });
      const product = findProduct(q);
      return product ? res.status(200).json({ ok: true, product }) : res.status(404).json({ ok: false, error: `Товар «${q}» не найден` });
    }

    if (what === 'warehouses' && post) {
      if (!allow(res, user, ['owner', 'manager'])) return;
      return result(res, saveWarehouse(idOf(a), body(req), user));
    }

    if (what === 'mp-warehouses' && post) {
      if (!allow(res, user, ['owner', 'manager'])) return;
      const id = idOf(a);
      if (id && b === 'delete') return result(res, deleteMpWarehouse(id, user));
      return result(res, saveMpWarehouse(id, body(req), user));
    }

    if (what === 'users') {
      if (!allow(res, user, ['owner'])) return;
      if (!post) return res.status(200).json({ ok: true, users: listUsers() });
      const id = idOf(a);
      return result(res, id ? updateUser(id, body(req), user) : createUser(body(req), user));
    }

    if (what === 'import' && post) {
      if (!allow(res, user, ['owner', 'manager', 'buyer'])) return;
      const { importFromSheet } = await import('./importSheet');
      const report = await importFromSheet(user, body(req)?.dryRun !== false);
      return res.status(200).json({ ok: true, report });
    }

    if (what === 'mp-sync' && post) {
      if (!allow(res, user, ['owner', 'manager'])) return;
      const { syncWithMarketplaces } = await import('./mpSync');
      const report = await syncWithMarketplaces(user);
      return res.status(200).json({ ok: true, report });
    }

    // ─── Этап 2: остатки, движения, перемещения, инвентаризация ─────────────
    const money = canSeeMoney(user.role);

    if (what === 'stock' && !post) {
      return res.status(200).json({ ok: true, ...stockSnapshot(whScope) });
    }

    if (what === 'movements') {
      const id = idOf(a);
      if (!post) {
        if (id) {
          const m = getMovement(id, money);
          if (!m || (whScope && !whScope.includes(m.whId) && !(m.counterWh && whScope.includes(m.counterWh)))) return res.status(404).json({ ok: false, error: 'Движение не найдено' });
          return res.status(200).json({ ok: true, movement: m });
        }
        const q = req.query;
        return res.status(200).json({ ok: true, ...listMovements({
          whIds: whScope, whId: Number(q.whId) || undefined, productId: Number(q.productId) || undefined,
          kind: q.kind ? String(q.kind) : undefined, q: q.q ? String(q.q).trim() : undefined,
          from: Number(q.from) || undefined, to: Number(q.to) || undefined, inTransit: q.inTransit === '1',
          limit: Number(q.limit) || 100, offset: Number(q.offset) || 0,
        }, money) });
      }
      if (id && b === 'reverse') return result(res, reverseMovement(id, String(body(req)?.reason ?? ''), user));
      return result(res, postMovement(body(req), user));
    }

    if (what === 'transfers' && post) {
      const id = idOf(a);
      if (id && b === 'receive') return result(res, receiveTransfer(id, body(req), user));
      return result(res, sendTransfer(body(req), user));
    }

    if (what === 'inventories') {
      const id = idOf(a);
      if (!post) {
        if (!id) return res.status(200).json({ ok: true, inventories: listInventories(whScope) });
        const inv = getInventory(id);
        if (!inv || (whScope && !whScope.includes(inv.whId))) return res.status(404).json({ ok: false, error: 'Инвентаризация не найдена' });
        return res.status(200).json({ ok: true, inventory: inv });
      }
      if (!id) return result(res, createInventory(body(req), user));
      if (b === 'count') return result(res, setCount(id, body(req), user));
      if (b === 'finish') return result(res, finishInventory(id, user));
      return result(res, updateInventory(id, body(req), user));
    }

    // ─── Этап 3: заказы FBS ──────────────────────────────────────────────────
    if (what === 'orders') {
      if (!post && !a) {
        const q = req.query;
        return res.status(200).json({ ok: true, ...listOrders({
          whIds: whScope, mp: q.mp ? String(q.mp) : undefined, state: q.state ? String(q.state) : undefined,
          q: q.q ? String(q.q).trim() : undefined, problems: q.problems === '1', days: Number(q.days) || undefined, limit: Number(q.limit) || 200,
        }) });
      }
      const poller = await import('./ordersPoller');
      if (!post && a === 'status') {
        const last = kvGet('orders_last_compare');
        return res.status(200).json({ ok: true, ...poller.pollStatus(), compare: last ? JSON.parse(last) : null });
      }
      if (!allow(res, user, ['owner', 'manager'])) return;
      if (post && a === 'poll') return res.status(200).json({ ok: true, status: await poller.pollOrders(body(req)?.full === true) });
      if (post && a === 'compare') {
        const { compareWithSheet } = await import('./ordersCompare');
        const days = Math.min(Math.max(Number(body(req)?.days) || 3, 1), 30);
        const report = await compareWithSheet(days);
        kvSet('orders_last_compare', JSON.stringify(report));
        return res.status(200).json({ ok: true, report });
      }
    }

    if (what === 'history') {
      if (!allow(res, user, ['owner', 'manager'])) return;
      const hist = await import('./importHistory');
      if (!post && a === 'status') {
        const last = kvGet('last_reconcile');
        return res.status(200).json({ ok: true, importedAt: Number(kvGet('history_imported_at')) || null,
          cutoverAt: Number(kvGet(hist.CUTOVER_KEY)) || null, reconcile: last ? JSON.parse(last) : null });
      }
      if (post && a === 'import') return res.status(200).json({ ok: true, report: await hist.importHistoryFromSheet(user, body(req)?.dryRun !== false) });
      if (post && a === 'reconcile') return res.status(200).json({ ok: true, reconcile: await hist.reconcileWithSheet() });
    }

    if (what === 'audit' && !post) {
      if (!allow(res, user, ['owner', 'manager'])) return;
      return res.status(200).json({ ok: true, audit: listAudit({
        entity: req.query.entity ? String(req.query.entity) : undefined,
        entityId: req.query.id ? String(req.query.id) : undefined,
        limit: Number(req.query.limit) || 200,
      }) });
    }

    return res.status(404).json({ ok: false, error: 'sklad_not_found' });
  } catch (e) {
    console.warn('[sklad]', what, (e as Error)?.stack ?? e);
    return res.status(500).json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
}
