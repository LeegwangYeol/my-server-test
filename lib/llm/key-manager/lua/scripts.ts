/**
 * Production-Ready In-Line Lua Scripts for Redis Key Management
 * Target: lib/llm/key-manager/lua/scripts.ts
 *
 * NOTE: Exported as TypeScript string constants to prevent ENOENT errors
 * in esbuild CJS single-bundle environments (Vercel Serverless Function).
 */

/**
 * RESERVE_KEY_LUA
 * Atomically cleans expired leases, evaluates WLIF load, respects exclusion list,
 * transitions WARMUP canaries, and registers lease in ZSET.
 *
 * KEYS[1] = "openrouter:keys:list"
 * ARGV[1] = Default max concurrency ceiling (e.g. 5)
 * ARGV[2] = Lease timeout in ms (e.g. 45000)
 * ARGV[3] = Comma-separated excludeKeyIds (e.g. "key_1,key_2")
 * ARGV[4] = Optional client nonce / UUID for cryptographic entropy
 *
 * Returns: { key_id, lease_token } on success, or { nil, error_code } on failure
 */
export const RESERVE_KEY_LUA = `
local keys_set = KEYS[1]
local default_max_conc = tonumber(ARGV[1]) or 5
local lease_timeout_ms = tonumber(ARGV[2]) or 45000
local exclude_raw = ARGV[3] or ""
local client_nonce = ARGV[4]

-- Parse exclusion set with whitespace trimming
local excluded = {}
for id in string.gmatch(exclude_raw, "([^,]+)") do
    local trimmed = string.match(id, "^%s*(.-)%s*$")
    if trimmed and #trimmed > 0 then
        excluded[trimmed] = true
    end
end

-- Monotonic Redis server time (eliminates microVM clock skew)
local rtime = redis.call('TIME')
local now = tonumber(rtime[1]) * 1000 + math.floor(tonumber(rtime[2]) / 1000)

local key_ids = redis.call('SMEMBERS', keys_set)
if not key_ids or #key_ids == 0 then
    return { nil, "ERR_NO_KEYS_CONFIGURED" }
end

local best_key = nil
local lowest_tier = 999
local lowest_load_score = 999999999
local oldest_used = 9999999999999

for _, key_id in ipairs(key_ids) do
    if not excluded[key_id] then
        local hash = "openrouter:key:" .. key_id
        local leases_zset = "openrouter:key:" .. key_id .. ":leases"
        
        -- 1. Self-Pruning: Purge all expired leases atomically
        redis.call('ZREMRANGEBYSCORE', leases_zset, '-inf', now)
        local in_flight = tonumber(redis.call('ZCARD', leases_zset)) or 0

        local data = redis.call('HMGET', hash, 'state', 'tier', 'cooldown_until', 'max_concurrency', 'weight', 'last_used_at', 'account_id')
        local state = data[1] or 'ACTIVE'
        local tier = tonumber(data[2]) or 0
        local cooldown_until = tonumber(data[3]) or 0
        local max_conc = tonumber(data[4]) or default_max_conc
        local weight = tonumber(data[5]) or 1
        if weight <= 0 then weight = 1 end
        local last_used = tonumber(data[6]) or 0
        local account_id = data[7] or ""

        -- Check account-wide breaker
        local account_broken = false
        if account_id ~= "" then
            if redis.call('EXISTS', "openrouter:account:" .. account_id .. ":broken") == 1 then
                account_broken = true
            end
        end

        local eligible = false

        if not account_broken and state ~= 'EXHAUSTED' and state ~= 'DISABLED' then
            if state == 'ACTIVE' then
                if in_flight < max_conc then
                    eligible = true
                end
            elseif state == 'RATE_LIMITED' or state == 'TRANSIENT_BACKOFF' then
                if now >= cooldown_until then
                    -- Cooldown elapsed: promote to WARMUP
                    redis.call('HSET', hash, 'state', 'WARMUP')
                    state = 'WARMUP'
                    if in_flight == 0 then
                        eligible = true
                    end
                end
            elseif state == 'WARMUP' then
                -- Strict canary lock: exactly 1 in-flight permitted
                if in_flight == 0 then
                    eligible = true
                end
            end
        end

        if eligible then
            -- Weighted Least-In-Flight Load Score (scaled by 1000 for integer precision)
            local load_score = math.floor((in_flight * 1000) / weight)

            if tier < lowest_tier then
                lowest_tier = tier
                lowest_load_score = load_score
                oldest_used = last_used
                best_key = key_id
            elseif tier == lowest_tier then
                if load_score < lowest_load_score then
                    lowest_load_score = load_score
                    oldest_used = last_used
                    best_key = key_id
                elseif load_score == lowest_load_score then
                    if last_used < oldest_used then
                        oldest_used = last_used
                        best_key = key_id
                    end
                end
            end
        end
    end
end

if best_key then
    local selected_hash = "openrouter:key:" .. best_key
    local selected_leases = "openrouter:key:" .. best_key .. ":leases"
    
    local nonce = (client_nonce and client_nonce ~= "") and client_nonce or tostring(math.random(10000, 99999))
    local lease_token = best_key .. ":" .. now .. ":" .. nonce
    local lease_expire_at = now + lease_timeout_ms

    -- Register lease in ZSET
    redis.call('ZADD', selected_leases, lease_expire_at, lease_token)
    redis.call('HINCRBY', selected_hash, 'total_requests', 1)
    redis.call('HSET', selected_hash, 'last_used_at', now)

    -- If key is in WARMUP, bind this specific lease token as the authorized canary
    local current_state = redis.call('HGET', selected_hash, 'state')
    if current_state == 'WARMUP' then
        redis.call('HSET', selected_hash, 'canary_token', lease_token)
    end

    return { best_key, lease_token }
else
    return { nil, "ERR_NO_ELIGIBLE_KEYS" }
end
`;

/**
 * ACKNOWLEDGE_HANDSHAKE_LUA
 * Phase 1: Immediately graduates WARMUP keys to ACTIVE upon receiving HTTP 200 headers (<500ms).
 *
 * KEYS[1] = "openrouter:key:" .. key_id (or key_id)
 * ARGV[1] = lease_token
 *
 * Returns: "GRADUATED_ACTIVE" if promoted, or "OK" otherwise
 */
export const ACKNOWLEDGE_HANDSHAKE_LUA = `
local hash = KEYS[1]
if string.sub(hash, 1, 15) ~= "openrouter:key:" then
    hash = "openrouter:key:" .. hash
end
local lease_token = ARGV[1]

local state = redis.call('HGET', hash, 'state') or 'ACTIVE'
local canary_token = redis.call('HGET', hash, 'canary_token') or ''

if state == 'WARMUP' and lease_token == canary_token then
    -- Canary test passed on handshake! Graduate immediately to ACTIVE
    redis.call('HSET', hash, 'state', 'ACTIVE')
    redis.call('HSET', hash, 'consecutive_429s', 0)
    redis.call('HSET', hash, 'consecutive_failures', 0)
    redis.call('HDEL', hash, 'last_error_code', 'last_error_message', 'canary_token')
    return "GRADUATED_ACTIVE"
end

return "OK"
`;

/**
 * RELEASE_KEY_LUA
 * Phase 2: Removes ZSET lease token, resolves state transitions, protects EXHAUSTED from 429 overwrites,
 * and bulk-invalidates linked accounts on 402/401 in <5ms.
 *
 * KEYS[1] = "openrouter:key:" .. key_id (or key_id)
 * ARGV[1] = lease_token
 * ARGV[2] = HTTP status code (200, 401, 402, 429, 499, 500, 502, 503, 504, 0)
 * ARGV[3] = Cooldown duration ms
 * ARGV[4] = Diagnostic error message
 *
 * Returns: "OK" or "ALREADY_RELEASED"
 */
export const RELEASE_KEY_LUA = `
local hash = KEYS[1]
local key_id
if string.sub(hash, 1, 15) == "openrouter:key:" then
    key_id = string.sub(hash, 16)
else
    key_id = hash
    hash = "openrouter:key:" .. key_id
end

local lease_token = ARGV[1]
local status = tonumber(ARGV[2]) or 0
local cooldown_ms = tonumber(ARGV[3]) or 0
local err_msg = ARGV[4] or ""

local leases_zset = "openrouter:key:" .. key_id .. ":leases"

-- Monotonic Redis server time
local rtime = redis.call('TIME')
local now = tonumber(rtime[1]) * 1000 + math.floor(tonumber(rtime[2]) / 1000)

-- 1. Idempotently remove lease from ZSET
local removed = redis.call('ZREM', leases_zset, lease_token)
if removed == 0 then
    -- Lease already expired or released; do not double-process state unless failure
    if status == 200 or status == 499 then
        return "ALREADY_RELEASED"
    end
end

local data = redis.call('HMGET', hash, 'state', 'account_id', 'canary_token')
local current_state = data[1] or 'ACTIVE'
local account_id = data[2] or ""
local canary_token = data[3] or ""

-- 2. State transitions
if status == 200 then
    if current_state == 'WARMUP' and lease_token == canary_token then
        redis.call('HSET', hash, 'state', 'ACTIVE')
        redis.call('HSET', hash, 'consecutive_429s', 0)
        redis.call('HSET', hash, 'consecutive_failures', 0)
        redis.call('HDEL', hash, 'last_error_code', 'last_error_message', 'canary_token')
    elseif current_state == 'ACTIVE' then
        redis.call('HSET', hash, 'consecutive_failures', 0)
    end

elseif status == 429 then
    -- CRITICAL SAFETY GUARD: NEVER overwrite permanent EXHAUSTED with temporary RATE_LIMITED!
    if current_state ~= 'EXHAUSTED' then
        redis.call('HINCRBY', hash, 'consecutive_429s', 1)
        redis.call('HSET', hash, 'state', 'RATE_LIMITED')
        redis.call('HSET', hash, 'cooldown_until', now + cooldown_ms)
        redis.call('HSET', hash, 'last_error_code', 429)
        redis.call('HSET', hash, 'last_error_message', err_msg)
    end

elseif status == 402 or status == 401 then
    -- Permanent Financial / Auth Exhaustion
    redis.call('HSET', hash, 'state', 'EXHAUSTED')
    redis.call('HSET', hash, 'last_error_code', status)
    redis.call('HSET', hash, 'last_error_message', err_msg)

    -- Bulk-invalidate all keys sharing the same account in <5ms
    if account_id ~= "" then
        redis.call('SET', "openrouter:account:" .. account_id .. ":broken", 1, 'EX', 86400)
        local linked_keys = redis.call('SMEMBERS', "openrouter:account:" .. account_id .. ":keys")
        if linked_keys then
            for _, linked_id in ipairs(linked_keys) do
                local lhash = "openrouter:key:" .. linked_id
                redis.call('HSET', lhash, 'state', 'EXHAUSTED')
                redis.call('HSET', lhash, 'last_error_code', status)
                redis.call('HSET', lhash, 'last_error_message', "Account credit balance exhausted")
            end
        end
    end

elseif status >= 500 or (status == 0 and cooldown_ms > 0) or status == 408 then
    -- Transient network drop, timeout, or upstream 5xx
    local fails = redis.call('HINCRBY', hash, 'consecutive_failures', 1)
    if fails >= 3 and current_state == 'ACTIVE' then
        redis.call('HSET', hash, 'state', 'TRANSIENT_BACKOFF')
        redis.call('HSET', hash, 'cooldown_until', now + 2500)
    end
    redis.call('HSET', hash, 'last_error_code', status)
    redis.call('HSET', hash, 'last_error_message', err_msg)

elseif status == 0 and cooldown_ms == 0 then
    -- Provider outage or zero-cooldown bypass: zero failure penalty
    redis.call('HSET', hash, 'last_error_code', 0)
    redis.call('HSET', hash, 'last_error_message', err_msg)

elseif status == 499 then
    -- Client stream abort: slot already reclaimed by ZREM, no error penalty applied
    redis.call('HSET', hash, 'last_error_code', 499)
    redis.call('HSET', hash, 'last_error_message', "Client stream aborted")
end

return "OK"
`;
