function getRuntimeConfigIdentity(config) {
    if (!config || typeof config !== 'object') {
        return '';
    }

    if (config.type === 'token') {
        return [
            'token',
            config.baseUrl || '',
            config.account_id || '',
            config.access_token || ''
        ].join(':');
    }

    if (config.type === 'api_key') {
        return [
            'api_key',
            config.baseUrl || '',
            config.apiKey || ''
        ].join(':');
    }

    return '';
}

function cloneRuntime(runtime) {
    return runtime && typeof runtime === 'object' ? { ...runtime } : runtime;
}

function clampInitialActiveIndex(index, configsLength) {
    if (!Number.isInteger(index) || configsLength <= 0) {
        return 0;
    }

    return Math.max(0, Math.min(index, configsLength - 1));
}

function buildRuntimeMap(configs) {
    const runtimeByIdentity = new Map();

    for (const config of configs || []) {
        const identity = getRuntimeConfigIdentity(config);
        if (!identity) {
            continue;
        }

        runtimeByIdentity.set(identity, cloneRuntime(config.runtime));
    }

    return runtimeByIdentity;
}

function reconcileRuntimeConfigs(previousConfigs, nextConfigs, options = {}) {
    const {
        previousActiveConfig = null,
        previousActiveIndex = 0,
        runtimeOverrides = []
    } = options;
    const runtimeByIdentity = buildRuntimeMap(previousConfigs);

    for (const config of runtimeOverrides) {
        const identity = getRuntimeConfigIdentity(config);
        if (!identity) {
            continue;
        }

        runtimeByIdentity.set(identity, cloneRuntime(config.runtime));
    }

    const previousActiveIdentity = getRuntimeConfigIdentity(previousActiveConfig);
    let matchedActiveIndex = -1;

    nextConfigs.forEach((config, index) => {
        const identity = getRuntimeConfigIdentity(config);
        if (!identity) {
            return;
        }

        const runtime = runtimeByIdentity.get(identity);
        if (runtime) {
            config.runtime = runtime;
        }

        if (previousActiveIdentity && identity === previousActiveIdentity) {
            matchedActiveIndex = index;
        }
    });

    return {
        configs: nextConfigs,
        initialActiveConfigIndex: matchedActiveIndex !== -1
            ? matchedActiveIndex
            : clampInitialActiveIndex(previousActiveIndex, nextConfigs.length)
    };
}

module.exports = {
    getRuntimeConfigIdentity,
    reconcileRuntimeConfigs,
};
