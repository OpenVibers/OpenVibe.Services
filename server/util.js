'use strict';

/** Small shared pieces: the error a route answers with, and the OVRN helpers every resource route uses. */
const contracts = require('openvibe-contracts');

/**
 * A refusal this service decided: `status` + a stable problem code + a public detail. The error handler
 * in server/app.js turns it into application/problem+json; anything else is a 500.
 */
class ServiceError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.status = status;
        this.code = code;
        this.detail = detail;
        this.extra = extra;
    }
}

function fail(status, code, detail, extra) { throw new ServiceError(status, code, detail, extra); }

/**
 * An OVRN parsed with openvibe-contracts' one parser (contracts.resources.parse — Services never splits
 * on ':'), or a 400 resources.bad_name. `:ovrn` routes use this before anything else.
 */
function parseOvrn(name) {
    const parsed = contracts.resources.parse(name);
    if (!parsed) fail(400, 'resources.bad_name', `${name} is not a resource name (ovrn:<service>:<project_id>:<type>/<id>)`);
    return parsed;
}

module.exports = { ServiceError, fail, parseOvrn };
