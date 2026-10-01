/**
 * harness.js — эмулятор рантайма wb-rules для автотестов.
 *
 * Модули грузятся в vm-контекст ровно с тем окружением, которое даёт
 * wb-rules: dev[], defineVirtualDevice, defineRule, таймеры,
 * PersistentStorage, readConfig, module.static. Время виртуальное:
 * env.advance(ms) прокручивает таймеры в порядке срабатывания.
 *
 * Правила (defineRule) срабатывают не внутри записи, а следующим
 * событием — как в настоящем wb-rules, где обработчик запускается
 * после того, как текущий отработал.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// WBCLIM_MOD_DIR — для мутационной проверки тестов на копии модулей
const MOD_DIR = process.env.WBCLIM_MOD_DIR || path.join(ROOT, 'etc', 'wb-rules-modules');

function createEnv(opts) {
  opts = opts || {};
  const env = {
    now: opts.start || 1000000,
    store: {},
    meta: {},
    rules: [],
    devices: {},
    writes: [], // [топик, значение] — всё, что записал код
    logs: [],
    storages: opts.storages || {}, // PersistentStorage: переживает «перезагрузку»
    statics: opts.statics || {}, // module.static по имени модуля
    timers: new Map(),
    seq: 0
  };

  function addTimer(cb, ms, rep) {
    const id = ++env.seq;
    env.timers.set(id, { cb, at: env.now + Math.max(0, ms || 0), period: rep ? Math.max(1, ms) : 0 });
    return id;
  }
  function delTimer(id) {
    env.timers.delete(id);
  }

  /** Прокрутить время вперёд, выполняя таймеры по порядку. */
  env.advance = function (ms) {
    const until = env.now + ms;
    for (;;) {
      let best = null,
        bt = Infinity;
      for (const [id, t] of env.timers) {
        if (t.at <= until && (t.at < bt || (t.at === bt && id < best))) {
          best = id;
          bt = t.at;
        }
      }
      if (best === null) break;
      const t = env.timers.get(best);
      env.now = Math.max(env.now, t.at);
      if (t.period > 0) t.at = env.now + t.period;
      else env.timers.delete(best);
      t.cb();
    }
    env.now = until;
  };

  /** Записать значение «снаружи» (датчик, пользователь в веб-интерфейсе). */
  env.set = function (topic, v) {
    const old = env.store[topic];
    env.store[topic] = v;
    if (!(topic + '#error' in env.meta)) env.meta[topic + '#error'] = '';
    if (old !== v) {
      for (const r of env.rules) if (r.topics.indexOf(topic) >= 0) addTimer(() => r.then(v), 0, false);
    }
  };
  env.get = (topic) => env.store[topic];
  env.setError = (topic, err) => {
    env.meta[topic + '#error'] = err;
  };
  /** Объявить внешний контрол (реле, датчик) со значением. */
  env.control = function (topic, v) {
    env.store[topic] = v;
    env.meta[topic + '#error'] = '';
  };

  const devProxy = new Proxy(
    {},
    {
      get(_, k) {
        if (typeof k !== 'string') return undefined;
        if (k.indexOf('#') >= 0) {
          const t = k.split('#')[0];
          if (!(t in env.store)) return null;
          return env.meta[k] !== undefined ? env.meta[k] : '';
        }
        return env.store[k];
      },
      set(_, k, v) {
        if (k.indexOf('#') >= 0) env.meta[k] = v;
        else {
          env.writes.push([k, v, env.now]);
          env.set(k, v);
        }
        return true;
      }
    }
  );

  function defineVirtualDevice(id, spec) {
    env.devices[id] = spec;
    const units = {},
      order = {};
    for (const n of Object.keys(spec.cells)) {
      const c = spec.cells[n];
      const topic = id + '/' + n;
      // как в wb-rules: значение контрола сохраняется между перезагрузками
      if (!(topic in env.store) || c.forceDefault) {
        env.store[topic] = c.value !== undefined ? c.value : c.type === 'pushbutton' ? false : 0;
      }
      env.meta[topic + '#error'] = '';
    }
    spec._units = units;
    spec._order = order;
    return {
      getControl: (n) => ({
        setUnits(u) {
          units[n] = u;
        },
        setOrder(o) {
          order[n] = o;
        },
        setTitle() {}
      })
    };
  }

  function defineRule(name, c) {
    // повторное определение правила с тем же именем заменяет прежнее
    env.rules = env.rules.filter((r) => r.name !== name);
    env.rules.push({ name, topics: Array.isArray(c.whenChanged) ? c.whenChanged : [c.whenChanged], then: c.then });
  }

  const fmt = (f, ...a) => {
    let i = 0;
    return String(f).replace(/\{\}/g, () => (i < a.length ? String(a[i++]) : '{}'));
  };
  const logFn = (...a) => env.logs.push(fmt(...a));
  logFn.debug = () => {};
  logFn.info = (...a) => env.logs.push('I ' + fmt(...a));
  logFn.warning = (...a) => env.logs.push('W ' + fmt(...a));
  logFn.error = (...a) => env.logs.push('E ' + fmt(...a));

  function PersistentStorage(name) {
    if (!env.storages[name]) env.storages[name] = {};
    return env.storages[name];
  }

  env.config = opts.config || null;
  const globalProto = opts.globalProto || {};
  const sandbox = {
    dev: devProxy,
    log: logFn,
    defineVirtualDevice,
    defineRule,
    PersistentStorage,
    readConfig: () => JSON.parse(JSON.stringify(env.config)),
    setTimeout: (cb, ms) => addTimer(cb, ms, false),
    setInterval: (cb, ms) => addTimer(cb, ms, true),
    clearTimeout: delTimer,
    clearInterval: delTimer,
    Date: { now: () => env.now },
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
    Error,
    console
  };
  sandbox.global = Object.create(globalProto);
  const ctx = vm.createContext(sandbox);
  env.ctx = ctx;
  env.globalProto = globalProto;

  const modCache = {};
  function wbrequire(name) {
    if (modCache[name]) return modCache[name].exports;
    if (!env.statics[name]) env.statics[name] = {};
    const m = { exports: {}, static: env.statics[name], filename: name };
    modCache[name] = m;
    const code = fs.readFileSync(path.join(MOD_DIR, name + '.js'), 'utf8');
    vm.runInContext('(function(exports,module,require){' + code + '\n})', ctx, { filename: name + '.js' })(
      m.exports,
      m,
      wbrequire
    );
    return m.exports;
  }
  sandbox.require = wbrequire;
  env.require = wbrequire;

  /** Выполнить файл сценария как wb-rules. */
  env.runScript = function (file) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
  };

  /** Сколько раз писали в топик (после отметки mark). */
  env.countWrites = (topic, mark) => env.writes.slice(mark || 0).filter((w) => w[0] === topic).length;

  return env;
}

/* ---------------- отчёт ---------------- */

function makeChecker() {
  const r = { pass: 0, fail: 0 };
  r.check = (name, cond, detail) => {
    if (cond) {
      r.pass++;
      console.log('  ✓ ' + name);
    } else {
      r.fail++;
      console.log('  ✗ ' + name + (detail !== undefined ? ' -> ' + detail : ''));
    }
  };
  r.done = (title) => {
    console.log('\n' + title + ': ' + r.pass + ' прошло, ' + r.fail + ' упало');
    if (r.fail) process.exitCode = 1;
  };
  return r;
}

module.exports = { createEnv, makeChecker, ROOT, MOD_DIR };
