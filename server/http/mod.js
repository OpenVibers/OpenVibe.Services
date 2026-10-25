'use strict';
/**
 * /mod: every way to change how the network works, for yourself, your community or everyone (the owner 2026-10-25:
 * "openvibe.services as the place to mod the network or build your own sites with the SDK and APIs"). Each card names
 * something that works today and links to where it is done or documented; packaged mods say plainly what waits on the
 * open decisions in ADR-013 (signing and review), so nothing here promises an install path that does not exist.
 */
const { html } = require('../render/html');

const GH = 'https://github.com/OpenVibers';
const EXAMPLES = `${GH}/OpenVibe.Examples`;
const example = (name) => `${EXAMPLES}/tree/main/examples/${name}`;

// What anyone can extend today, without asking anyone.
const TODAY = [
    { title: 'Your own site on the network', text: 'Sign-in with OpenVibe, the shared navbar and footer, and the home-page kit (hero, numbers, cards and rails, spotlight, FAQ, "Part of OpenVibe") that the network\'s own sites are built from.', href: `${GH}/OpenVibe.Shared/blob/main/docs/home-pages.md`, link: 'The home-page kit' },
    { title: 'A chat bot', text: 'A bot in its own room that always says it is a bot, from the chat-bot example, or Vibe and your own AI members in any room you run.', href: example('chat-bot'), link: 'chat-bot example' },
    { title: 'Alerts and work into a team room', text: 'A workspace room on OpenVibe.Chat takes signed hooks: a Watch firing, an OpenVibe event or a line of text arrives as a message from Vibe, and can queue a task for the team or for your own computer.', href: 'https://openvibe.chat/rooms', link: 'Rooms' },
    { title: 'Watches that act', text: 'Follow any page, feed or API, and when it changes: notify you, call a signed webhook, give an agent a task, start a job on your own machine, or open a coding task.', href: 'https://openvibe.watch/', link: 'OpenVibe.Watch' },
    { title: 'Agents of your own', text: 'Personal agents on OpenVibe.Actor with your instructions and tools, run now or on a schedule, under your own allowance.', href: 'https://openvibe.actor/docs', link: 'Actor docs' },
    { title: 'Robots, devices and computers', text: 'Write a driver as a plugin for OpenVibe.Node, pair the machine, and drive it through Bot\'s one gate with roles, limits and an e-stop. Share a computer\'s screen into a room.', href: 'https://openvibe.bot/docs', link: 'Bot docs' },
    { title: 'Game worlds', text: 'Build a world in the OpenVibe.Games editor and publish it: anyone can join it, and it shows up in search.', href: 'https://openvibe.games/worlds', link: 'Worlds' },
    { title: 'React to the whole network', text: 'Subscribe to events (streams going live, posts, recordings, jobs) with durable cursors or signed webhooks, and build on them.', href: example('event-subscriber'), link: 'event-subscriber example' },
    { title: 'Change OpenVibe itself', text: 'Every service is open source. Propose a change on OpenVibe.Codes, where OpenVibe is built, or send a pull request to the repository it touches.', href: 'https://openvibe.codes/', link: 'OpenVibe.Codes' },
];

function modPage({ examplesTag = 'v0.3.0' } = {}) {
    const create = `npx --package=https://codeload.github.com/OpenVibers/OpenVibe.Examples/tar.gz/refs/tags/${examplesTag} create-openvibe-app my-mod --template mod`;
    return html`<h1>Mod the network</h1>
<p>OpenVibe is open source end to end, and every product has an API. These are the ways to change how it works for you, for your community, or for everyone, today.</p>
<h2 id="today">Extend it today</h2>
<ul class="cards">${TODAY.map((c) => html`<li><a href="${c.href}"><strong>${c.title}</strong></a><span>${c.text}</span><a class="muted" href="${c.href}">${c.link} →</a></li>`)}</ul>
<h2 id="packaged">Packaged mods</h2>
<p>A packaged mod changes a product from the inside: a game's rules, an overlay on a stream. It is described by a <strong>mod manifest</strong> (<code>mods.mod-manifest@1</code> in openvibe-contracts): its id, version, publisher, target runtime, the capabilities it asks for, its assets and its budget. Installing one gives it its own principal on OpenVibe.Network, granted only the capabilities that were approved, and revoking that grant stops it at once.</p>
<ol class="steps">
<li><strong>Start one</strong> from the template: <code>${create}</code></li>
<li><strong>Check its manifest</strong> against the pinned contracts on the <a href="/manifests/validate">manifest validator</a>, which also says which capabilities an install could grant.</li>
<li><strong>Ask for it</strong> to be installed: open a proposal on <a href="https://openvibe.codes/">OpenVibe.Codes</a>.</li>
</ol>
<p class="muted">What waits: today only staff install mods (with the approved capabilities), because how a mod release is signed and how it is reviewed are open decisions for the owner (<a href="/docs/adr/ADR-013">ADR-013</a>, amendment of 2026-09-24). Mods that run their own code also wait for sandboxed hosting. Until then a mod is data plus the scripting each game's own sandbox provides. This page will say when that changes.</p>
<h2 id="start">Where to start</h2>
<ol class="steps">
<li><a href="/projects">Create a project</a> and add a sandbox app: its sandbox capabilities are approved at once.</li>
<li>Pick a card above, or start from an example: <a href="${EXAMPLES}">OpenVibe.Examples</a> (MIT, each with a smoke test).</li>
<li>Read the <a href="/docs">platform reference</a> and the <a href="/docs/sdk">SDK</a>, generated from the same contracts the services enforce.</li>
</ol>`;
}

module.exports = { modPage, TODAY };
