/**
 * @file wbclim-zone.js
 * @description Виртуальное устройство «Климатическая зона» (помещение).
 *
 * Пользователь задаёт уставку. Зона считает ПОТРЕБНОСТЬ В ТЕПЛЕ 0..100 %
 * и раздаёт её всем своим исполнителям — сейчас это конвекторы и тёплый
 * пол, дальше фанкойлы, кондиционеры, вентиляция, увлажнение. Каждый
 * исполнитель сам решает, как отработать потребность своими выходами.
 * За счёт этого все системы помещения работают как одно целое: одна
 * уставка, один регулятор, одна потребность.
 *
 * ДОЛИ ПОТРЕБНОСТИ. Каждый исполнитель отвечает за свой участок общей
 * потребности и растягивает его на свои 0..100 % (роль, см. roleOf).
 * Пол медленный и экономичный — он должен нести базовую нагрузку, а
 * быстрый конвектор только догревать: утром, после проветривания, в
 * сильный мороз. Если в помещении есть и пол, и конвектор, а участки не
 * заданы, они выбираются сами (AUTO_SPLIT). Явные числа при смене состава
 * помещения никто не пересчитает (wbmix, грабля №18), поэтому по
 * умолчанию — «авто».
 *
 * РЕГУЛЯТОР ПОТРЕБНОСТИ (П + медленная И):
 *
 *   e = уставка − температура
 *   П = 100 % · e / band             band — зона пропорциональности, К:
 *                                    при отставании на band потребность 100 %
 *   И += 100 % · e · dt / (band · ti) ti — время интегрирования, мин
 *   потребность = clamp(П + И, 0, 100)
 *
 * П-часть даёт то, что описано в задаче: чем больше разница, тем сильнее
 * воздействие, на подходе к уставке — к нулю. Но чистый П-регулятор
 * держит температуру с недобором: в мороз тепло нужно и при нулевой
 * разнице, а П-часть при нулевой разнице даёт ноль. И-часть медленно
 * накапливает «сколько тепла нужно помещению вообще» и снимает недобор.
 * ti = 0 — чистый П-регулятор.
 *
 * Anti-windup: И ограничена 0..100 % и не растёт, пока потребность уже
 * 100 % (иначе после долгого разгона холодной комнаты она дала бы
 * перегрев). Отрицательной И не бывает: потребность в тепле не бывает
 * меньше нуля, а отрицательная И задерживала бы открытие клапана.
 *
 * ЗАЩИТЫ И РЕЖИМЫ:
 *   - проверка конфигурации до запуска (пустые топики, один выход дважды);
 *   - несколько датчиков температуры — среднее по исправным; отказ части —
 *     авария без остановки; отказ всех — безопасная потребность;
 *   - открытое окно — отопление на паузе, интегратор заморожен;
 *   - защита от замерзания работает и в выключенной зоне;
 *   - ручная потребность — для пусконаладки: проверить клапаны и все
 *     скорости вентиляторов, не трогая уставку.
 */

var U = require('wbclim-util');
var CONV = require('wbclim-convector');
var FLOOR = require('wbclim-floor');

var MODE_AUTO = 0;
var MODE_MANUAL = 1;

var STATE_TITLES = {
  off: 'Выключено',
  idle: 'Уставка достигнута',
  ready: 'Поддержание уставки',
  heating: 'Нагрев',
  window: 'Окно открыто',
  manual: 'Ручная потребность',
  frost: 'Защита от замерзания',
  fault: 'Авария',
  config: 'Ошибка настройки'
};

/* Типы исполнителей. Новые системы (фанкойл, кондиционер...)
 * добавляются сюда — зона работает с ними через общий интерфейс:
 *   update(demand, now, dt, force, zone), publish(set, now), statusText(now),
 *   getFault(), getWarning(), detach(), halt();
 * для проверки конфигурации и карточки — controlsOf, missingOf, outputsOf.
 * speed: slow — инерционный исполнитель (база), fast — быстрый (догрев). */
var DEVICE_TYPES = {
  convector: {
    make: CONV.Convector,
    controlsOf: CONV.controlsOf,
    missingOf: CONV.missingOf,
    outputsOf: CONV.outputsOf,
    name: 'Конвектор',
    speed: 'fast'
  },
  floor: {
    make: FLOOR.Floor,
    controlsOf: FLOOR.controlsOf,
    missingOf: FLOOR.missingOf,
    checkOf: FLOOR.checkOf,
    outputsOf: FLOOR.outputsOf,
    name: 'Тёплый пол',
    speed: 'slow'
  }
};

/**
 * Участки потребности по умолчанию, если в помещении есть и медленные,
 * и быстрые исполнители. Подобраны на стенде test/sim.js (модель стяжки
 * и конвектора), см. PROMPT.md, раздел 8.
 */
var AUTO_SPLIT = { slow: [0, 70], fast: [50, 100] };

var ID_RE = /^[a-z0-9_]+$/;

/** id исполнителя: из конфига или по порядку. */
function deviceId(d, i) {
  return d && d.id ? d.id : 'dev' + (i + 1);
}

function deviceTitle(d, i) {
  var t = DEVICE_TYPES[(d && d.type) || 'convector'];
  return d && d.title ? d.title : (t ? t.name : 'Устройство') + ' ' + (i + 1);
}

/**
 * Роль исполнителя в нагреве -> участок общей потребности [from, to]:
 *   auto   — по составу помещения: есть и пол, и конвектор — пол база,
 *            конвектор догрев; иначе 0–100 %;
 *   base   — основной (AUTO_SPLIT.slow), boost — догрев (AUTO_SPLIT.fast);
 *   all    — 0–100 %;
 *   custom — demandFrom..demandTo.
 * Роль не задана, а числа заданы (конфиг вручную) — custom. В форме
 * числа не могут быть «пустыми» (редактор сохранил бы нули), поэтому
 * авто выражено ролью, а не отсутствием чисел.
 */
function roleOf(d) {
  if (d.role) return d.role;
  return U.isNum(d.demandFrom) || U.isNum(d.demandTo) ? 'custom' : 'auto';
}

function demandWindows(list) {
  var hasSlow = false;
  var hasFast = false;
  var i, t;
  for (i = 0; i < list.length; i++) {
    t = DEVICE_TYPES[(list[i] && list[i].type) || 'convector'];
    if (t && t.speed === 'slow') hasSlow = true;
    if (t && t.speed === 'fast') hasFast = true;
  }
  var mixed = hasSlow && hasFast;
  var res = [];
  for (i = 0; i < list.length; i++) {
    var d = list[i] || {};
    t = DEVICE_TYPES[d.type || 'convector'];
    var role = roleOf(d);
    var w;
    if (role === 'custom') w = [U.def(d.demandFrom, 0), U.def(d.demandTo, 100)];
    else if (role === 'base') w = AUTO_SPLIT.slow;
    else if (role === 'boost') w = AUTO_SPLIT.fast;
    else if (role === 'all') w = [0, 100];
    else w = mixed && t ? AUTO_SPLIT[t.speed] : [0, 100];
    res.push([w[0], w[1]]);
  }
  return res;
}

/** Доля исполнителя: участок [from, to] общей потребности -> 0..100 %. */
function localDemand(demand, w) {
  if (demand >= 100) return 100;
  return U.clamp(((demand - w[0]) * 100) / (w[1] - w[0]), 0, 100);
}

/* ================================================================== */

/**
 * @param {Object} cfg описание зоны, см. README и /etc/wb-climate.conf
 * @param {Array} problems ошибки конфигурации (см. checkZones):
 *                если есть, зона не запускается
 */
function Zone(cfg, problems) {
  this.cfg = cfg;
  this.id = cfg.id;
  this.title = cfg.title || cfg.id;
  this.problems = problems || [];

  this.log = {
    debug: function () {
      if (cfg.debug) log.debug.apply(null, arguments);
    },
    info: function () {
      log.info.apply(null, arguments);
    },
    warning: function () {
      log.warning.apply(null, arguments);
    },
    error: function () {
      log.error.apply(null, arguments);
    }
  };

  /* ---------- регулирование ---------- */
  var c = cfg.control || {};
  this.periodMs = U.def(c.period, 10) * 1000;
  this.spMin = U.def(c.setpointMin, 10);
  this.spMax = U.def(c.setpointMax, 30);
  this.spDefault = U.clamp(U.def(cfg.defaultSetpoint, 22), this.spMin, this.spMax);
  // По умолчанию — по стенду test/sim.js на пяти моделях помещений
  // (типовое, лёгкое, конвектор вдвое мощнее и слабее нужного, подача
  // 45 °C): band 2 / ti 60 выводили утром с 20 на 22 °C за 83 мин,
  // band 1,5 / ti 30 — за 19 мин при той же точности ±0,15 К.
  // Чистый П (ti 0) в мороз недогревал на 0,6–0,9 К.
  this.bandDefault = U.def(c.band, 1.5);
  this.tiDefault = U.def(c.ti, 30);
  this.readyBand = U.def(c.readyBand, 0.3);

  /* ---------- защиты ---------- */
  var s = cfg.safety || {};
  this.frostOn = s.frostProtect !== false;
  this.frostT = U.def(s.frostTemp, 7);
  this.frostHyst = 2;
  this.failSafeDemand = U.clamp(U.def(s.failSafeDemand, 0), 0, 100);

  /* ---------- датчики ---------- */
  var sn = cfg.sensors || {};
  // Воздух в помещении меняется медленно: 0,2 К/с (12 К/мин) — заведомо
  // выше любого реального процесса, но отсекает мусор с шины.
  this.temp = new U.SensorSet(sn.temperature, { tau: U.def(sn.tau, 30), min: -40, max: 80, maxRate: 0.2 });
  this.hum = new U.SensorSet(sn.humidity, { tau: U.def(sn.tau, 30), min: 0, max: 100, maxRate: 1 });

  /* ---------- окно ---------- */
  var w = cfg.window || {};
  this.winTopics = U.topicList(w.topics);
  this.winInvert = !!w.invert;
  this.winDelayMs = U.def(w.delay, 30) * 1000;
  this.winSince = null;
  this.winOpen = false;

  /* ---------- рабочее состояние ---------- */
  this.integral = 0;
  this.p = 0;
  this.demand = 0;
  this.frostActive = false;
  this.state = 'off';
  this.alarms = {};
  this.lastTick = 0;
  this.tickTimer = null;
  this.kickTimer = null;
  this.devices = [];

  this._buildDevice();

  // Ошибка конфигурации — зону не запускаем и исполнители не создаём:
  // они пишут в реле, а реле может оказаться чужим.
  if (this.problems.length) {
    this._setState('config');
    this._alarm('config', 'зона не запущена — ' + this.problems.join('; '));
    this._publishAlarms();
    return;
  }

  var list = cfg.devices || [];
  var windows = demandWindows(list);
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var t = DEVICE_TYPES[d.type || 'convector'];
    var dc = {};
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) dc[k] = d[k];
    dc.id = deviceId(d, i);
    dc.title = deviceTitle(d, i);
    var inst = new t.make(dc, { log: this.log, id: this.id });
    inst.window = windows[i];
    this.devices.push(inst);
  }

  // Интегратор — «сколько тепла помещению нужно вообще». Набирается
  // десятками минут, поэтому храним его: без этого после перезапуска
  // контроллера в мороз помещение полчаса недогревалось бы.
  this.storage = new PersistentStorage('wbclim_' + this.id, { global: true });
  var si = U.toNum(this.storage.integral);
  if (U.isNum(si)) this.integral = U.clamp(si, 0, 100);
  this.savedI = this.integral;
  this.savedAt = null;

  this._defineRules();
  this._start();
}

/* ================================================================== */
/*  Виртуальное устройство                                             */
/* ================================================================== */

Zone.prototype._buildDevice = function () {
  var cfg = this.cfg;
  var cells = {};
  var order = [];
  var units = {};
  function add(name, spec, u) {
    cells[name] = spec;
    order.push(name);
    if (u) units[name] = u;
  }

  add('enabled', { title: { en: 'Enabled', ru: 'Включено' }, type: 'switch', value: U.def(cfg.defaultEnabled, true) });
  add('mode', {
    title: { en: 'Mode', ru: 'Режим' },
    type: 'value',
    readonly: false,
    value: MODE_AUTO,
    enum: {
      0: { en: 'Auto (setpoint)', ru: 'Авто (по уставке)' },
      1: { en: 'Manual demand (commissioning)', ru: 'Ручная потребность (проверка)' }
    }
  });
  // Уставка — value, а не range: range по конвенциям Wiren Board только
  // целочисленный, а уставку помещения задают с шагом 0,5 °C.
  add(
    'setpoint',
    {
      title: { en: 'Setpoint', ru: 'Уставка' },
      type: 'value',
      readonly: false,
      value: this.spDefault,
      min: this.spMin,
      max: this.spMax
    },
    'deg C'
  );
  add('temperature', { title: { en: 'Temperature', ru: 'Температура' }, type: 'value', value: 0 }, 'deg C');
  if (this.hum.configured) {
    add('humidity', { title: { en: 'Humidity', ru: 'Влажность' }, type: 'value', value: 0 }, '%, RH');
  }
  if (this.winTopics.length) {
    add('window', { title: { en: 'Window open', ru: 'Окно открыто' }, type: 'switch', value: false, readonly: true });
  }
  add('demand', { title: { en: 'Heat demand', ru: 'Потребность в тепле' }, type: 'value', value: 0 }, '%');
  add('demand_i', { title: { en: 'Integral part', ru: 'Интегральная часть' }, type: 'value', value: 0 }, '%');
  add(
    'manual_demand',
    { title: { en: 'Manual demand', ru: 'Ручная потребность' }, type: 'range', value: 0, min: 0, max: 100 },
    '%'
  );

  // Контролы исполнителей (клапан, вентилятор, датчики, состояние) —
  // набор задаёт сам тип исполнителя
  var list = cfg.devices || [];
  for (var i = 0; i < list.length; i++) {
    var d = list[i] || {};
    var t = DEVICE_TYPES[d.type || 'convector'];
    if (!t) continue;
    var id = deviceId(d, i);
    var ctls = t.controlsOf(d, deviceTitle(d, i));
    for (var j = 0; j < ctls.length; j++) add(id + '_' + ctls[j].name, ctls[j].spec, ctls[j].units);
  }

  add('state', { title: { en: 'State', ru: 'Состояние' }, type: 'text', value: STATE_TITLES.off });
  add('alarm', { title: { en: 'Alarm', ru: 'Авария' }, type: 'switch', value: false, readonly: true });
  add('alarm_text', { title: { en: 'Alarm details', ru: 'Описание аварии' }, type: 'text', value: '' });

  /* --- настройка регулятора на объекте --- */
  add(
    'band',
    {
      title: { en: 'Proportional band', ru: 'Зона пропорциональности' },
      type: 'value',
      readonly: false,
      value: this.bandDefault,
      min: 0.5,
      max: 10
    },
    'deg C'
  );
  // Минуты — в подписи: единицы «min» в конвенциях Wiren Board нет
  add('ti', {
    title: { en: 'Integral time, min (0 = off)', ru: 'Время интегрирования, мин (0 = выкл)' },
    type: 'range',
    value: this.tiDefault,
    min: 0,
    max: 240
  });
  add('reset_alarm', { title: { en: 'Reset alarm', ru: 'Сброс аварии' }, type: 'pushbutton' });

  this.vdev = defineVirtualDevice(this.id, {
    title: { en: this.title, ru: this.title },
    cells: cells
  });

  // order и units в описании cells не документированы — сеттерами
  for (var j = 0; j < order.length; j++) {
    try {
      var ctl = this.vdev.getControl(order[j]);
      ctl.setOrder(j + 1);
      if (units[order[j]]) ctl.setUnits(units[order[j]]);
    } catch (e) {
      /* контрол не создан */
    }
  }
};

Zone.prototype._c = function (name) {
  return this.id + '/' + name;
};

/** Функция записи контролов исполнителя: имя без префикса. */
Zone.prototype._setter = function (prefix) {
  var self = this;
  return function (name, value) {
    self._set(prefix + name, value);
  };
};

Zone.prototype._set = function (name, value) {
  try {
    if (dev[this._c(name)] !== value) dev[this._c(name)] = value;
  } catch (e) {
    /* контрол не создан */
  }
};

/* ================================================================== */
/*  Правила                                                            */
/* ================================================================== */

/**
 * Внеочередной такт с небольшой задержкой: пользователь сменил уставку,
 * открыли окно — реагируем сразу, не дожидаясь очередного такта.
 * Через таймер, а не прямым вызовом: несколько изменений подряд дают
 * один такт, и такт никогда не запускается изнутри другого такта.
 */
Zone.prototype._kick = function () {
  var self = this;
  if (this.kickTimer !== null) return;
  this.kickTimer = setTimeout(function () {
    self.kickTimer = null;
    self._safeTick();
  }, 300);
};

Zone.prototype._defineRules = function () {
  var self = this;

  defineRule(this.id + '_wbclim_reset_alarm', {
    whenChanged: this._c('reset_alarm'),
    then: function () {
      self.alarms = {};
      self._publishAlarms();
      self.log.info('[{}] аварии сброшены оператором', self.id);
    }
  });

  var watch = [this._c('enabled'), this._c('mode'), this._c('setpoint'), this._c('manual_demand')];
  for (var i = 0; i < this.winTopics.length; i++) watch.push(this.winTopics[i]);
  defineRule(this.id + '_wbclim_kick', {
    whenChanged: watch,
    then: function () {
      self._kick();
    }
  });
};

/* ================================================================== */
/*  Такт                                                               */
/* ================================================================== */

Zone.prototype._start = function () {
  var self = this;
  this.lastTick = Date.now();
  this.tickTimer = setInterval(function () {
    self._safeTick();
  }, this.periodMs);
  // Первый такт — сразу, а не через период: после перезагрузки сценария
  // выходы должны прийти в нужное состояние без паузы.
  this._kick();
  this.log.info(
    '[{}] зона «{}» запущена: исполнителей {}, такт {} с',
    this.id,
    this.title,
    this.devices.length,
    this.periodMs / 1000
  );
};

Zone.prototype._safeTick = function () {
  try {
    this._tick();
  } catch (e) {
    this.log.error('[{}] ошибка такта: {}', this.id, e);
  }
};

Zone.prototype._alarm = function (key, text) {
  if (this.alarms[key] !== text) {
    if (!this.alarms[key]) this.log.warning('[{}] АВАРИЯ: {}', this.id, text);
    this.alarms[key] = text;
  }
};

Zone.prototype._clearAlarm = function (key) {
  if (this.alarms[key]) delete this.alarms[key];
};

Zone.prototype._publishAlarms = function () {
  var list = [];
  for (var k in this.alarms) {
    if (Object.prototype.hasOwnProperty.call(this.alarms, k)) list.push(this.alarms[k]);
  }
  this._set('alarm', list.length > 0);
  this._set('alarm_text', list.join('; '));
};

Zone.prototype._setState = function (s) {
  this.state = s;
  this._set('state', STATE_TITLES[s] || s);
};

/** Число с контрола в пределах; некорректное — значение по умолчанию. */
Zone.prototype._num = function (name, d, lo, hi) {
  var v = U.toNum(dev[this._c(name)]);
  return U.isNum(v) ? U.clamp(v, lo, hi) : d;
};

/** Уставка с контрола: в пределах и с шагом 0,1; неверный ввод исправляется на карточке. */
Zone.prototype._setpoint = function () {
  var raw = U.toNum(dev[this._c('setpoint')]);
  var sp = U.isNum(raw) ? U.round(U.clamp(raw, this.spMin, this.spMax), 1) : this.spDefault;
  if (raw !== sp) this._set('setpoint', sp);
  return sp;
};

/** Окно: открыто дольше задержки. Проветривание на минуту не в счёт. */
Zone.prototype._window = function (now) {
  if (!this.winTopics.length) return false;
  var raw = false;
  var bad = [];
  for (var i = 0; i < this.winTopics.length; i++) {
    var t = this.winTopics[i];
    var e = U.linkError(t);
    if (e) {
      bad.push(e);
      continue;
    }
    var v = dev[t];
    var on = v === true || v === 1 || v === '1';
    if (this.winInvert ? !on : on) raw = true;
  }
  if (bad.length) this._alarm('window_sensor', 'датчик окна: ' + bad.join(', ') + ' — считаю закрытым');
  else this._clearAlarm('window_sensor');

  if (raw) {
    if (this.winSince === null) this.winSince = now;
  } else this.winSince = null;
  this.winOpen = raw && now - this.winSince >= this.winDelayMs;
  this._set('window', this.winOpen);
  return this.winOpen;
};

/**
 * Регулятор потребности: П + медленная И.
 * @returns {number} потребность, %
 */
Zone.prototype._regulate = function (sp, t, dt) {
  var band = this._num('band', this.bandDefault, 0.5, 10);
  var ti = this._num('ti', this.tiDefault, 0, 240);
  var e = sp - t;
  this.p = (100 * e) / band;
  if (ti > 0 && dt > 0) {
    var di = (100 * e * dt) / (band * ti * 60);
    // Вверх не копим, пока выход и так 100 % — anti-windup
    if (!(di > 0 && this.p + this.integral >= 100)) {
      this.integral = U.clamp(this.integral + di, 0, 100);
    }
  } else if (ti <= 0) {
    this.integral = 0;
  }
  return U.clamp(this.p + this.integral, 0, 100);
};

Zone.prototype._tick = function () {
  var now = Date.now();
  var dt = (now - this.lastTick) / 1000;
  if (dt < 0 || dt > 3600) dt = this.periodMs / 1000;
  this.lastTick = now;

  /* ---------- 1. Датчики ---------- */
  this.temp.poll(dt);
  var t = this.temp.get(null);
  this._set('temperature', t === null ? 0 : U.round(t, 1));
  if (!this.temp.ok()) {
    this._alarm('temp', 'нет данных о температуре: ' + this.temp.faults());
    this._clearAlarm('temp_part');
  } else {
    this._clearAlarm('temp');
    var part = this.temp.faults();
    if (part) this._alarm('temp_part', 'неисправен датчик ' + part + ', работаю по остальным');
    else this._clearAlarm('temp_part');
  }
  if (this.hum.configured) {
    this.hum.poll(dt);
    this._set('humidity', U.round(this.hum.get(0), 1));
    var hf = this.hum.faults();
    if (hf) this._alarm('hum', 'неисправен датчик влажности ' + hf);
    else this._clearAlarm('hum');
  }

  /* ---------- 2. Условия ---------- */
  var enabled = dev[this._c('enabled')] === true;
  var mode = U.toNum(dev[this._c('mode')]) === MODE_MANUAL ? MODE_MANUAL : MODE_AUTO;
  var sp = this._setpoint();
  var win = this._window(now);

  if (this.frostOn && t !== null) {
    if (t < this.frostT) this.frostActive = true;
    else if (t > this.frostT + this.frostHyst) this.frostActive = false;
  } else if (t === null) {
    this.frostActive = false;
  }

  /* ---------- 3. Потребность и состояние ---------- */
  var demand = 0;
  var state;
  if (this.frostActive) {
    // Выше выключателя и окна: замёрзшие трубы дороже открытого окна
    demand = 100;
    state = 'frost';
    this._alarm('frost', 'защита от замерзания: ' + U.round(t, 1) + ' °C');
  } else {
    this._clearAlarm('frost');
    if (!enabled) {
      state = 'off';
    } else if (t === null) {
      // Температуры нет — регулировать нечем. Безопасная потребность
      // (по умолчанию 0) и авария; интегратор не трогаем.
      demand = this.failSafeDemand;
      state = 'fault';
    } else if (win) {
      state = 'window';
    } else if (mode === MODE_MANUAL) {
      demand = this._num('manual_demand', 0, 0, 100);
      state = 'manual';
    } else {
      demand = this._regulate(sp, t, dt);
      if (demand <= 0) state = 'idle';
      else if (sp - t > this.readyBand) state = 'heating';
      else state = 'ready';
    }
  }
  this.demand = demand;
  this._setState(state);
  this._set('demand', U.round(demand, 1));
  this._set('demand_i', U.round(this.integral, 1));
  this._saveIntegral(now, false);

  /* ---------- 4. Исполнители ---------- */
  // Выключили зону или открыли окно — клапаны закрываются сразу,
  // без выдержки минимального времени.
  var force = state === 'off' || state === 'window';
  var info = { setpoint: sp, temperature: t };
  for (var i = 0; i < this.devices.length; i++) {
    var d = this.devices[i];
    try {
      d.update(localDemand(demand, d.window), now, dt, force, info);
      d.publish(this._setter(d.id + '_'), now);
    } catch (e) {
      this.log.error('[{}] ошибка исполнителя {}: {}', this.id, d.id, e);
    }

    var f = d.getFault();
    if (f) this._alarm('dev_' + d.id, d.title + ': ' + f);
    else this._clearAlarm('dev_' + d.id);
    var wn = d.getWarning();
    if (wn) this._alarm('warn_' + d.id, d.title + ': ' + wn);
    else this._clearAlarm('warn_' + d.id);
  }

  this._publishAlarms();
};

/* ================================================================== */

/**
 * Остановить такт.
 * @param {bool} halt снять команды с выходов. При перезагрузке сценария
 *        выходы не трогаем: новый экземпляр подхватит их как есть
 *        (открытый прогретый клапан, работающий вентилятор). Если гасить,
 *        вентиляторы после каждого сохранения стояли бы минуты прогрева.
 *        Гасим, только когда зону убрали из конфигурации.
 */
Zone.prototype.destroy = function (halt) {
  if (this.tickTimer !== null) {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
  if (this.kickTimer !== null) {
    clearTimeout(this.kickTimer);
    this.kickTimer = null;
  }
  for (var i = 0; i < this.devices.length; i++) {
    try {
      // Отложенное включение скорости после паузы отменяется в обоих
      // случаях: иначе таймер старого экземпляра включил бы реле уже
      // при новом.
      if (halt) this.devices[i].halt();
      else this.devices[i].detach();
    } catch (e) {
      /* модуль выходов недоступен */
    }
  }
};

/** Интегратор переживает перезапуск контроллера. */
Zone.prototype._saveIntegral = function (now, force) {
  if (!this.storage) return;
  var due = this.savedAt === null || now - this.savedAt >= 600000;
  if (force || (due && Math.abs(this.integral - this.savedI) >= 1)) {
    this.storage.integral = U.round(this.integral, 1);
    this.savedI = this.integral;
    this.savedAt = now;
  }
};

/* ================================================================== */
/*  Проверка конфигурации до запуска                                   */
/* ================================================================== */

/**
 * Проверка всех зон разом, до запуска любой из них.
 *
 *  1. Обязательные топики заполнены (эталонный конфиг поставляется
 *     с пустыми топиками — адреса модулей на каждом объекте свои).
 *  2. Типы исполнителей известны, id исполнителей уникальны в зоне.
 *  3. Ни один выход (реле термоголовки, реле скорости, аналоговый выход,
 *     регистр) не встречается дважды — ни в одной зоне, ни в разных.
 *     Реле, которым командуют два регулятора, включалось бы вразнобой.
 *     Датчики общими быть могут.
 *
 * @param {Array} zones секция zones конфигурации
 * @returns {Object} id зоны -> массив описаний ошибок
 */
function checkZones(zones) {
  var res = {};
  var all = [];
  var seenZones = {};
  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    if (!z || !z.id) continue;
    var p = (res[z.id] = res[z.id] || []);
    if (seenZones[z.id]) p.push('id «' + z.id + '» повторяется');
    seenZones[z.id] = true;

    if (!U.topicList(z.sensors && z.sensors.temperature).length) p.push('не задан датчик температуры');

    var list = z.devices || [];
    var ids = {};
    for (var j = 0; j < list.length; j++) {
      var d = list[j] || {};
      var title = deviceTitle(d, j);
      var t = DEVICE_TYPES[d.type || 'convector'];
      if (!t) {
        p.push(title + ': неизвестный тип «' + d.type + '»');
        continue;
      }
      var did = deviceId(d, j);
      if (!ID_RE.test(did)) p.push(title + ': id «' + did + '» — только латиница в нижнем регистре, цифры и _');
      if (ids[did]) p.push(title + ': id «' + did + '» повторяется');
      ids[did] = true;

      var miss = t.missingOf(d);
      if (miss.length) p.push(title + ': не задано: ' + miss.join(', '));
      var bad = t.checkOf ? t.checkOf(d) : [];
      for (var q = 0; q < bad.length; q++) p.push(title + ': ' + bad[q]);
      var role = roleOf(d);
      if (['auto', 'base', 'boost', 'all', 'custom'].indexOf(role) < 0) {
        p.push(title + ': неизвестная роль «' + role + '»');
      } else if (role === 'custom') {
        var df = U.def(d.demandFrom, 0);
        var dto = U.def(d.demandTo, 100);
        if (!(df >= 0 && dto <= 100 && df < dto)) {
          p.push(title + ': доля потребности ' + df + '…' + dto + ' % — нужно 0 ≤ от < до ≤ 100');
        }
      }

      var outs = t.outputsOf(d);
      for (var k = 0; k < outs.length; k++) {
        all.push({ topic: outs[k].topic, name: outs[k].name, zone: z.id, zoneTitle: z.title || z.id, dev: title });
      }
    }
  }
  for (var x = 0; x < all.length; x++) {
    for (var y = 0; y < all.length; y++) {
      var a = all[x];
      var b = all[y];
      if (x === y || a.topic !== b.topic) continue;
      if (a.zone === b.zone && y < x) continue; // внутри зоны — одно сообщение на пару
      res[a.zone].push(
        a.dev + ': ' + a.name + ' ' + a.topic + ' уже используется (' +
          b.dev + ', ' + b.name + (a.zone === b.zone ? '' : ', зона «' + b.zoneTitle + '»') + ')'
      );
    }
  }
  return res;
}

/**
 * Реестр экземпляров в module.static: общий для всех сценариев и
 * переживает автоперезагрузку файла правил. Без него после сохранения
 * сценария в веб-интерфейсе остался бы висячий setInterval, и выходами
 * управляли бы два такта сразу (wbmix, грабля №1).
 */
if (!module.static.zones) module.static.zones = {};

/**
 * @param {Object} cfg конфигурация зоны
 * @param {Array} [problems] результат checkZones() по всем зонам
 */
exports.create = function (cfg, problems) {
  var reg = module.static.zones;
  var prev = reg[cfg.id];
  if (prev) {
    try {
      prev.destroy(false);
      // Интегратор прежнего экземпляра — свежее сохранённого
      if (prev.storage) prev._saveIntegral(Date.now(), true);
    } catch (e) {
      log.error('wbclim: не удалось остановить прежний экземпляр {}: {}', cfg.id, e);
    }
  }
  if (problems === undefined) problems = checkZones([cfg])[cfg.id];
  var z = new Zone(cfg, problems);
  reg[cfg.id] = z;
  return z;
};

/**
 * Остановить и погасить зоны, которых больше нет в конфигурации.
 * Иначе после удаления зоны её вентиляторы работали бы бесконечно.
 * @param {Array} ids id зон текущей конфигурации
 */
exports.prune = function (ids) {
  var reg = module.static.zones;
  var keep = {};
  for (var i = 0; i < ids.length; i++) keep[ids[i]] = true;
  for (var id in reg) {
    if (!Object.prototype.hasOwnProperty.call(reg, id) || keep[id]) continue;
    try {
      reg[id].destroy(true);
      log.info('wbclim: зона {} удалена из конфигурации — выходы погашены', id);
    } catch (e) {
      log.error('wbclim: не удалось остановить зону {}: {}', id, e);
    }
    delete reg[id];
  }
};

exports.get = function (id) {
  return module.static.zones[id];
};

exports.Zone = Zone;
exports.checkZones = checkZones;
exports.MODE_AUTO = MODE_AUTO;
exports.MODE_MANUAL = MODE_MANUAL;
