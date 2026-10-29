'use strict';
// What openvibe.services tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves; the OpenAPI document is this service's own, published
// from the pinned openvibe-contracts (http/docs.js serves it at /docs/api/services.json).
module.exports = {
    id: 'services',
    name: 'OpenVibe.Services',
    purpose: 'The developer platform of OpenVibe: projects, apps, scoped credentials, capability grants, usage and releases over every OpenVibe service, with API, contract, SDK and event reference generated from the exact versions production runs.',
    home: 'https://openvibe.services',
    site: 'openvibe.services',
    api: '/api/v1',
    openapi: '/docs/api/services.json',
    docs: '/docs',
    policy: {
        auth: ['none', 'Network OIDC', 'bearer'],
        rateLimit: '300 page requests and 240 API requests a minute per address; sign-in 60 attempts per 15 minutes',
    },
};
