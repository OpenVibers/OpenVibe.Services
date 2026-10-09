'use strict';

/**
 * Account export and deletion → Services (ADR-033; openvibe-sdk/account-data). Services stores a person as
 * `user:usr_…` (an app acts as `app:app_…`, which is never a person's).
 *
 *   their own, deleted      playground runs and recipe runs they started
 *   project rows, authorless manifests and releases belong to the project and its app, not to the person who pressed
 *                           the button: they stay. created_by is NOT NULL there, so it becomes `deleted` (the resource
 *                           index then reports no owner); published_by, deprecated_by and revoked_by become NULL; the
 *                           resource index's owner becomes NULL
 *   kept                    release_log (append-only by trigger), services_control_log and the trust tiers a staff
 *                           member set: the audit trail of who published, revoked, reviewed or changed what, kept for
 *                           accountability (counted as retained)
 *
 * The export carries what they started and what they created. Nothing exported is a secret: manifests hold no
 * credentials, and the control log is not exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const user = (usr) => `user:${usr}`;
const anonymize = { anonymize: {} };

const TABLES = [
    { table: 'playground_runs', subject: 'actor', value: user, file: 'playground-runs.json', order: 'at', columns: ['id', 'at', 'project_id', 'app_id', 'kind', 'capability', 'credential', 'outcome', 'stage', 'http_status', 'code', 'detail'] },
    { table: 'services_recipe_runs', subject: 'subject', value: (usr) => [usr, user(usr)], file: 'recipe-runs.json', order: 'started_at' },
    { table: 'releases', subject: 'published_by', value: user, file: null, erase: anonymize },
    { table: 'releases', subject: 'deprecated_by', value: user, file: null, erase: anonymize },
    { table: 'releases', subject: 'revoked_by', value: user, file: null, erase: anonymize },
    { table: 'services_resources', subject: 'owner_subject', value: (usr) => [usr, user(usr)], file: null, erase: anonymize },
    { table: 'release_log', subject: 'actor', value: user, file: null, erase: { keep: 'the append-only release log is the audit trail of who published or revoked what' } },
    { table: 'trust', subject: 'set_by', value: user, file: null, erase: { keep: 'a trust tier names the staff member who set it, for accountability' } },
    { table: 'trust_history', subject: 'set_by', value: user, file: null, erase: { keep: 'the trust history names the staff member who set each tier, for accountability' } },
    { table: 'services_control_log', subject: 'actor_subject', value: (usr) => [usr, user(usr)], file: null, erase: { keep: 'the control-plane audit log, kept for accountability' } },
];

/** Manifests and releases they created: exported, then made authorless in extraErase (created_by is NOT NULL). */
async function extraExport(db, subject) {
    const files = [];
    const manifests = await db.many(`SELECT id, kind, app_id, project_id, subject_id, version, body, created_at FROM manifests
        WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [user(subject)]);
    if (manifests.length) files.push({ name: 'manifests.json', content: manifests });
    const releases = await db.many(`SELECT id, app_id, project_id, environment, kind, subject_id, name, version, status, notes, created_at
        FROM releases WHERE created_by = $1 ORDER BY created_at DESC LIMIT 5000`, [user(subject)]);
    if (releases.length) files.push({ name: 'releases.json', content: releases });
    return files;
}

async function extraErase(t, subjects, counts) {
    const forms = subjects.map(user);
    counts.add(counts.retained, 'tombstones', await t.exec("UPDATE manifests SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [forms]));
    counts.add(counts.retained, 'tombstones', await t.exec("UPDATE releases SET created_by = 'deleted' WHERE created_by = ANY($1::text[])", [forms]));
}

/** The account-data handle for Services' database (store.db). */
function create({ db, log = console } = {}) {
    return createAccountData({
        db, service: 'services', tables: TABLES, extraExport, extraErase, log,
        note: 'Manifests and releases belong to their project and stay there without your name.',
    });
}

module.exports = { create, TABLES, TOPICS };
