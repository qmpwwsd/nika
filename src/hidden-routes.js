// The five routes that remove a session or a detected folder from nika's lists, and show it again (0.5.4, RM; design-053-rm 4.1, 4.3).
// api-app.js mounts them under its guards (secret, Origin, Sec-Fetch-Site, JSON for writes, no-store): app tier only, never on :3335. A route
// only changes nika's own hidden.json (src/hidden.js): no process is touched, nothing of Claude's is deleted. Every write body is exactly `{}`;
// the id or key in the path is only a lookup key, and nothing in a request names a path, a label or a time.
import { UUID, PROJECT_KEY, segment } from './ids.js';
import { clean } from './text.js';
import { addedTo, loadConfig } from './store.js';
import { hideSession, hideGroup, unhideSession, unhideGroup, readHidden } from './hidden.js';

const HIDDEN_ROWS = 100;

const err = (status, error, message) => ({ status, body: { error, message } });
const NOT_FOUND = (what) => err(404, 'not_found', `no such ${what}`);
const UNAVAILABLE = () => err(503, 'index_unavailable', "nika can't read its list of sessions right now. Nothing changed.");
const WRITE_FAILED = () => err(500, 'write_failed', "nika couldn't update its list of removed items. Nothing changed.");
const BAD_BODY = () => err(400, 'invalid', 'body must be {}');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const emptyBody = (b) => isPlain(b) && Object.keys(b).length === 0;
const inPane = (a) => Boolean(a?.live && a?.pane);

/**
 * The routes as api-app's `{ method, re, cap, handler }` list (a handler gets `{ params, query, body, req }` and resolves `{ status, body }`).
 * `ctx` is api-app's ctx ({ env, now, findSession, findSessions, findGroup }); `snapshot()` resolves nika's unfiltered snapshot (api-app's pane-eligibility
 * one) or null when it could not be taken; `cap` is the write body cap.
 */
export function hiddenRoutes({ ctx, cap, snapshot }) {
  const look = () => Promise.resolve().then(snapshot).catch(() => null);
  /** The ids of the rows that run in a tmux pane nika sees now: a row in a pane always shows, so Remove refuses it and the write prunes it. */
  const inTmux = (snap) => new Set((snap?.groups ?? []).flatMap((g) => g.agents.filter(inPane).map((a) => a.id)));

  const routes = [];
  const route = (method, re, handler) => routes.push({ method, re, cap: method === 'GET' ? 0 : cap, handler });

  route('POST', /^\/api\/app\/session\/([^/]+)\/remove$/, async ({ params, body }) => {
    if (!emptyBody(body)) return BAD_BODY();
    const id = segment(params[0], UUID);
    if (!id) return NOT_FOUND('session');
    let found;
    try {
      found = await ctx.findSession(id);
    } catch {
      return UNAVAILABLE();
    }
    if (!found || found.agent.id !== id) return NOT_FOUND('session'); // a host id answers the row that continues it: not the row asked for
    const live = inTmux(await look());
    if (inPane(found.agent) || live.has(id)) return err(409, 'in-tmux', 'This session runs in a tmux pane, so it stays in the list.');
    try {
      const { dropped } = await hideSession(id, ctx.env, { now: ctx.now(), liveInTmux: live });
      return { status: 200, body: { hidden: true, dropped } };
    } catch {
      return WRITE_FAILED();
    }
  });

  // Show again works for any id, also one nika has no transcript for any more: the entry would otherwise stay until it expires
  route('POST', /^\/api\/app\/session\/([^/]+)\/unhide$/, async ({ params, body }) => {
    if (!emptyBody(body)) return BAD_BODY();
    const id = segment(params[0], UUID);
    if (!id) return NOT_FOUND('session');
    const live = inTmux(await look());
    try {
      await unhideSession(id, ctx.env, { now: ctx.now(), liveInTmux: live });
    } catch {
      return WRITE_FAILED();
    }
    return { status: 200, body: { hidden: false } };
  });

  route('POST', /^\/api\/app\/groups\/([^/]+)\/remove$/, async ({ params, body }) => {
    if (!emptyBody(body)) return BAD_BODY();
    const key = segment(params[0], PROJECT_KEY);
    if (!key) return NOT_FOUND('folder');
    const snap = await look();
    if (!snap || !Array.isArray(snap.groups)) return UNAVAILABLE();
    const now = ctx.now();
    const stored = (await readHidden(ctx.env, now)).groups.has(key);
    let group = snap.groups.find((g) => g.key === key) ?? null;
    if (!group) {
      // the snapshot holds the sessions of the last 7 days; a folder whose sessions all ended earlier is found by an index-only read of every transcript
      try {
        group = (await ctx.findGroup?.(key)) ?? null;
      } catch {
        if (!stored) return UNAVAILABLE(); // "no such folder" would be a guess; a key that is already stored is stamped again anyway
      }
    }
    if (!group && !stored) return NOT_FOUND('folder');
    if (group && group.root === null) return NOT_FOUND('folder'); // the "(unknown)" folder has no working folder to name
    const { config } = await loadConfig(ctx.env);
    // a folder nika knows is checked by key and by working folder; a stored key that has no folder in the snapshot any more, by key only
    if (addedTo(config.projects)(group ?? { key, root: null })) return err(409, 'registered', 'This folder is a project in nika, so it stays in the list.');
    try {
      const { dropped } = await hideGroup(key, ctx.env, { now, liveInTmux: inTmux(snap) });
      const sessions = group ? group.agents.filter((a) => !inPane(a)).length : 0;
      return { status: 200, body: { hidden: true, sessions, dropped } };
    } catch {
      return WRITE_FAILED();
    }
  });

  route('POST', /^\/api\/app\/groups\/([^/]+)\/unhide$/, async ({ params, body }) => {
    if (!emptyBody(body)) return BAD_BODY();
    const key = segment(params[0], PROJECT_KEY);
    if (!key) return NOT_FOUND('folder');
    const live = inTmux(await look());
    try {
      await unhideGroup(key, ctx.env, { now: ctx.now(), liveInTmux: live });
    } catch {
      return WRITE_FAILED();
    }
    return { status: 200, body: { hidden: false } };
  });

  // What is removed, newest first, with what nika knows about each: a label and a folder from its unfiltered snapshot, a name and a project from
  // its index. Anything nika cannot read stays null and the list still answers; a bad hidden.json is an empty list (readHidden warns once).
  route('GET', /^\/api\/app\/hidden$/, async () => {
    const hidden = await readHidden(ctx.env, ctx.now());
    const allGroups = [...hidden.groups];
    const allSessions = [...hidden.sessions];
    const groups = allGroups.slice(0, HIDDEN_ROWS);
    const sessions = allSessions.slice(0, HIDDEN_ROWS);
    const snap = groups.length ? await look() : null;
    let found = new Map();
    if (sessions.length) {
      try {
        found = await ctx.findSessions(sessions.map(([id]) => id));
      } catch { /* the names stay unknown (null); the list still works */ }
    }
    return {
      status: 200,
      body: {
        groups: groups.map(([key, at]) => {
          const g = Array.isArray(snap?.groups) ? snap.groups.find((x) => x.key === key) : null;
          return { key, label: clean(g?.label, 120), root: clean(g?.root, 300), at };
        }),
        sessions: sessions.map(([id, at]) => {
          const hit = found.get(id);
          return { id, name: clean(hit?.agent?.name ?? hit?.agent?.title, 80), project: clean(hit?.group?.label, 120), at };
        }),
        more: { groups: allGroups.length - groups.length, sessions: allSessions.length - sessions.length },
      },
    };
  });

  return routes;
}
