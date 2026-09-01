const { ChannelType } = require('discord.js');
const store = require('../utils/store');

// Locks every text/announcement channel by denying @everyone Send Messages.
// Fires all the permission edits at once (Promise.allSettled) instead of
// one at a time — on a server with 20+ channels that's the difference
// between a multi-second lockdown and a near-instant one.
//
// NOTE: this does NOT flip raidProtectActive in the store — callers that
// need auto-kick protection to engage immediately (before these API calls
// even finish) should set that flag themselves first, then call this.
async function lockAllChannels(guild) {
  const everyoneId = guild.roles.everyone.id;
  const channels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
  );

  const results = await Promise.allSettled(
    [...channels.values()].map((channel) =>
      channel.permissionOverwrites.edit(everyoneId, { SendMessages: false }).then(() => channel.id)
    )
  );

  const locked = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') locked.push(r.value);
    else failed += 1;
  }

  // The channels are already locked in Discord at this point — that's the
  // actual protective effect. Persisting the list is only bookkeeping (so
  // a later /raidprotect off knows what to undo), so it runs in the
  // background instead of making the caller wait on a database write for
  // something that's already done.
  store.setLockedChannels(guild.id, locked).catch((err) =>
    console.error('Failed to persist locked channels:', err)
  );

  return { locked, failed };
}

async function unlockAllChannels(guild) {
  const everyoneId = guild.roles.everyone.id;
  const lockedIds = await store.getLockedChannels(guild.id); // cached — no DB wait in the common case

  const results = await Promise.allSettled(
    lockedIds.map((channelId) => {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return Promise.resolve(null);
      return channel.permissionOverwrites.edit(everyoneId, { SendMessages: null }).then(() => channelId);
    })
  );

  let unlocked = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value) unlocked += 1;
    } else {
      failed += 1;
    }
  }

  // Same reasoning as lockAllChannels — the unlock already happened in
  // Discord, so these are backgrounded bookkeeping writes, not blocking.
  store.setLockedChannels(guild.id, []).catch((err) => console.error('Failed to clear locked channels:', err));
  store.setRaidProtectActive(guild.id, false).catch((err) => console.error('Failed to clear raid-protect flag:', err));

  return { unlocked, failed };
}

module.exports = { lockAllChannels, unlockAllChannels };
