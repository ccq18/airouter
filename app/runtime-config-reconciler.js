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

    if (config.type === 'apikey') {
        return [
            config.type,
            config.baseUrl || '',
            config.apiKey || '',
            Array.isArray(config.support) ? config.support.join(',') : ''
        ].join(':');
    }

    return '';
}

function cloneRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object') {
        return runtime;
    }

    const cloned = { ...runtime };
    delete cloned.inFlight;
    delete cloned.dispatchSession;
    if (cloned.responseModel && typeof cloned.responseModel === 'object') {
        cloned.responseModel = {
            ...cloned.responseModel,
            active: false,
        };
    }
    if (Array.isArray(cloned.apiKeyRequestResults)) {
        cloned.apiKeyRequestResults = cloned.apiKeyRequestResults.map(item => (
            item && typeof item === 'object' ? { ...item } : item
        ));
    }
    return cloned;
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
