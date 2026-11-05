/**
 * Conversation-kind classification tests.
 *
 * The mapping is the whole point of the feature, so it is pinned against the
 * evidence that produced it: `biz_info.type` decides 订阅号 vs 服务号, the
 * `@chatroom` suffix decides 群聊, and neither the `gh_` prefix nor the
 * `isGroup` flag may be used as a proxy (service accounts often have custom
 * ids, and 公众号 are not groups).
 */
function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

const { KINDS, classifyAccount, filterByKind } = await import('../lib/wechat.js');

/* --------------------------- the declared set --------------------------- */
assert(Array.isArray(KINDS) && KINDS.length === 6, 'six conversation kinds are declared');
for (const kind of ['group', 'direct', 'subscription', 'service', 'official', 'system']) {
  assert(KINDS.includes(kind), `"${kind}" is one of the declared kinds`);
}

/* ------------------------- biz_info decides the kind ------------------------- */
assert(classifyAccount('gh_demo0001aa', 0) === 'subscription', 'biz_info.type 0 is a 订阅号');
assert(classifyAccount('gh_demo0002bb', 1) === 'service', 'biz_info.type 1 is a 服务号');
assert(classifyAccount('mcdonalds888', 1) === 'service', 'a service account with a custom id is still a 服务号');
assert(classifyAccount('qqsafe', 1) === 'service', 'qqsafe (no gh_ prefix) is a 服务号');
assert(classifyAccount('weibo', 0) === 'subscription', 'weibo (no gh_ prefix) is a 订阅号');
assert(classifyAccount('gh_demo0003cc', 2) === 'official', 'biz_info.type 2 stays 公众号');
assert(classifyAccount('gh_demo0004dd', 3) === 'official', 'biz_info.type 3 stays 公众号');

// biz_info wins over the username shape: a @chatroom cannot be a 公众号, but a
// gh_-looking id without biz_info is not one either.
assert(classifyAccount('gh_unknown0000', undefined) === 'direct', 'a gh_ id with no biz_info row is not treated as 公众号');
assert(classifyAccount('wxid_laowang', undefined) === 'direct', 'a plain wxid is a 私聊');

/* --------------------------- username shapes --------------------------- */
assert(classifyAccount('12345678901@chatroom', undefined) === 'group', '@chatroom is a 群聊');
assert(classifyAccount('25984982832214961@openim', undefined) === 'direct', 'an @openim enterprise contact is a 私聊');
assert(classifyAccount('notifymessage', undefined) === 'system', 'notifymessage is a 系统 conversation');
assert(classifyAccount('brandsessionholder', undefined) === 'system', 'brandsessionholder is a 系统 conversation');
assert(classifyAccount('@placeholder_foldgroup', undefined) === 'system', 'the folded-group placeholder is 系统');
assert(classifyAccount('mmo9cq80xqzXU6u-YPT_UIhEEoHm80@weclaw', undefined) === 'system', '@weclaw is 系统');
assert(classifyAccount('filehelper', undefined) === 'system', 'filehelper is 系统');

/* --------------------------- filterByKind --------------------------- */
const sessions = [
  { wxid: '12345678901@chatroom', kind: 'group' },
  { wxid: 'wxid_laowang', kind: 'direct' },
  { wxid: 'gh_demo0001aa', kind: 'subscription' },
  { wxid: 'gh_demo0002bb', kind: 'service' },
  { wxid: 'notifymessage', kind: 'system' },
];

assert(filterByKind(sessions, []).length === sessions.length, 'no filter returns every conversation');
assert(filterByKind(sessions, undefined).length === sessions.length, 'an undefined filter returns every conversation');
assert(filterByKind(sessions, ['group']).length === 1, 'filtering by group returns only the group');
assert(filterByKind(sessions, ['group', 'direct']).length === 2, 'two kinds can be requested at once');
assert(filterByKind(sessions, ['subscription']).length === 1, 'filtering by 订阅号 excludes 服务号');
assert(filterByKind(sessions, ['official']).length === 2, 'official covers both 订阅号 and 服务号');
assert(
  filterByKind(sessions, ['official']).length ===
    filterByKind(sessions, ['subscription']).length + filterByKind(sessions, ['service']).length,
  'official equals 订阅号 + 服务号',
);
assert(filterByKind(sessions, ['official', 'group']).length === 3, 'the umbrella composes with other kinds');
assert(filterByKind(sessions, ['bogus']).length === sessions.length, 'an unknown kind is ignored rather than emptying the list');
assert(filterByKind(sessions, ['bogus', 'group']).length === 1, 'an unknown kind does not cancel a valid one');
assert(filterByKind([], ['group']).length === 0, 'filtering an empty list is empty');
