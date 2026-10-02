/**
 * wb-climate.js — ОДНОФАЙЛОВАЯ СБОРКА
 *
 * Климат-контроль на Wiren Board: помещения, конвекторы (термоголовки
 * и вентиляторы — реле, 0-10 В, Modbus), тёплый пол (по датчикам пола).
 *
 * КУДА ЗАГРУЖАТЬ:
 *   Веб-интерфейс контроллера -> Правила -> Новый скрипт
 *   (файл ляжет в /etc/wb-rules/). Больше ничего копировать не нужно:
 *   модули и конфигурация уже внутри этого файла.
 *
 * ЧТО ПРАВИТЬ:
 *   Секцию CONFIG ниже — помещения, датчики, реле термоголовок,
 *   вентиляторов и петель пола. Всё ниже отметки «КОД» трогать не нужно.
 *
 * Для парка объектов лучше ставить пакетом (README, способ 1): там есть
 * страница настроек с выбором топиков из выпадающего списка.
 * Пакет и эта сборка одновременно не ставятся — зоны задвоятся.
 *
 * Сгенерировано из исходников wb-climate (tools/make-bundle.js).
 * Секцию кода вручную не редактировать.
 */

/* ==================================================================== *
 *                          К О Н Ф И Г У Р А Ц И Я                     *
 * ==================================================================== */

var CONFIG = {
  "zones": [
    {
      // Одна зона — одно помещение и одно виртуальное устройство.
      // id — латиница, цифры, _ ; он же MQTT-имя устройства.
      "id": "climate_living",
      "title": "Гостиная",
      "defaultEnabled": true,
      "defaultSetpoint": 22,

      "sensors": {
        // Один или несколько датчиков: работает по среднему из исправных
        "temperature": ["wb-msw-v3_21/Temperature"],
        // Влажность пока только показывается на карточке. Уставка
        // влажности появится вместе с увлажнителями.
        "humidity": ["wb-msw-v3_21/Humidity"],
        "tau": 30 // сглаживание показаний, с
      },

      // Датчик окна (геркон на дискретном входе). Окно открыто дольше
      // delay — отопление зоны на паузе. invert — если «открыто» = false.
      "window": { "topics": [], "invert": false, "delay": 30 },

      "control": {
        "period": 10, // такт, с
        // Зона пропорциональности, К: при отставании от уставки на band
        // потребность 100 % — клапан открыт, вентилятор на максимуме.
        "band": 1.5,
        // Время интегрирования, мин: как быстро снимается недобор,
        // когда тепла нужно постоянно (мороз). 0 — чистый П.
        "ti": 30,
        "setpointMin": 16,
        "setpointMax": 40
      },

      "safety": {
        "frostProtect": true, // работает и в выключенной зоне
        "frostTemp": 7,
        // Потребность при отказе всех датчиков температуры, %.
        // 0 — не греть (авария на карточке).
        "failSafeDemand": 0
      },

      "devices": [
        {
          // Активный внутрипольный конвектор: термоголовка + вентилятор
          // на трёх реле (по одному на скорость).
          "type": "convector",
          "id": "conv1", // латиница в нижнем регистре: префикс контролов
          "title": "Конвектор у окна",
          "valve": {
            "topics": ["wb-mr6c_45/K1"],
            "normallyOpen": false, // термоголовки NC (обесточена — закрыта)
            "mode": "onoff", // onoff — по потребности; pwm — ШИМ (для пола)
            "minOn": 120, // мин. время открытой, с
            "minOff": 120, // мин. время закрытой, с
            "cycle": 900, // период ШИМ, с (только для pwm)
            "openTime": 180 // время полного открытия термоголовки, с
          },
          "fan": {
            "type": "relays", // none | relays | analog | modbus
            "speeds": ["wb-mr6c_45/K2", "wb-mr6c_45/K3", "wb-mr6c_45/K4"],
            "relayMode": "exclusive", // одно реле на скорость
            "interlock": 500, // пауза при смене скорости, мс
            // Скорость по разнице «уставка − температура»: до 2 °C — 1,
            // 2–4 °C — 2, от 4 °C — 3; "demand" — по потребности помещения
            "speedBy": "delta",
            "deltaStep": 2, // шаг скорости по разнице, °C
            "deltaHyst": 0.3, // гистерезис по разнице, °C
            "start": 20, // по потребности: с какой потребности включается, %
            "hyst": 10, // по потребности: гистерезис снижения скорости, %
            "minStepTime": 60, // выдержка между сменами скорости, с
            "delay": 180, // не дуть, пока теплообменник не прогрелся, с
            "minWater": 30 // то же по датчику воды, если он задан, °C
          },
          // Датчик на теплообменнике/подаче конвектора (необязательно):
          // вентилятор ждёт горячую воду по нему, а не по таймеру
          "waterSensor": ""
        },
        {
          // Активный конвектор с ЕС-вентилятором 0-10 В (WB-MAO4)
          "type": "convector",
          "id": "conv2",
          "title": "Конвектор у балкона",
          "valve": { "topics": ["wb-mr6c_45/K5"] },
          "fan": {
            "type": "analog",
            "out": "wb-mao4_12/Channel 1",
            "valueMin": 0, // мВ при 0 % (для 2-10 В — 2000)
            "valueMax": 10000, // мВ при 100 %
            "min": 20, // минимальная скорость на ходу, %
            "max": 100,
            "enable": "" // реле питания вентилятора, если есть
          }
        },
        {
          // Пассивный конвектор — только термоголовка, как тёплый пол
          "type": "convector",
          "id": "conv3",
          "title": "Конвектор в эркере",
          "valve": { "topics": ["wb-mr6c_45/K6"] },
          "fan": { "type": "none" }
        }
        /*
        Конвектор со своим контроллером по Modbus (через шаблон
        wb-mqtt-serial): скорость пишется числом в его регистр.
        {
          "type": "convector", "id": "conv4", "title": "Конвектор Modbus",
          "valve": { "topics": ["conv_mb_1/Valve"] },
          "fan": { "type": "modbus", "out": "conv_mb_1/Fan Speed", "steps": 3 }
          // steps 0 — плавно: valueMin..valueMax при 0..100 %;
          // values [30, 60, 100] — ступени, когда регистр ждёт проценты
        }
        */,
        {
          // Тёплый пол в этом же помещении. Есть и пол, и конвекторы —
          // роль «auto»: пол основной (потребность 0–70 %), конвекторы
          // догрев (50–100 %). Пол регулируется по датчикам в стяжке:
          // цель пола от minFloor (помещению тепло) до maxFloor (холодно).
          "type": "floor",
          "id": "floor1",
          "title": "Тёплый пол",
          "valve": {
            "topics": ["wb-mr6c_46/K1", "wb-mr6c_46/K2"], // две петли
            "cycle": 1200 // ШИМ, если датчиков пола нет или они отказали
          },
          "floorSensors": ["wb-w1/28-00000a1b2c3d"],
          "minFloor": 0, // 0 — низ цели по уставке помещения
          "maxFloor": 29, // EN 1264: 29 жилые; СП 60.13330: 26
          "floorHyst": 0.5
        }
      ]
    },
    {
      // Санузел: только тёплый пол, «комфортный пол» — не ниже 26 °C,
      // даже если помещение греет полотенцесушитель
      "id": "climate_bath",
      "title": "Санузел",
      "defaultSetpoint": 24,
      "sensors": { "temperature": ["wb-msw-v3_22/Temperature"] },
      "devices": [
        {
          "type": "floor",
          "id": "floor1",
          "title": "Тёплый пол",
          "valve": { "topics": ["wb-mr6c_46/K3"] },
          "floorSensors": ["wb-w1/28-00000a1b2c3e"],
          "minFloor": 26,
          "maxFloor": 31
        }
      ]
    }
  ]
};

/* ==================================================================== *
 *                                К О Д                                 *
 *                    (ниже правки обычно не требуются)                 *
 * ==================================================================== */

// Реестр экземпляров хранится в прототипе глобального объекта: он общий
// для всех сценариев и переживает автоперезагрузку файла правил. Без него
// после каждого сохранения скрипта в веб-интерфейсе оставался бы висячий
// таймер, и выходами управляли бы сразу два такта.
if (!global.__proto__.__wbclimShared) global.__proto__.__wbclimShared = {};

(function () {
  var __defs = {};
  var __cache = {};

  function require(name) {
    if (__cache[name]) return __cache[name].exports;
    if (!__defs[name]) throw new Error('wbclim: модуль не найден: ' + name);
    var m = {
      exports: {},
      filename: name,
      // module.static — общее хранилище в прототипе глобального объекта,
      // чтобы поведение совпадало с обычными модулями
      static: global.__proto__.__wbclimShared
    };
    __cache[name] = m;
    __defs[name](m.exports, m, require);
    return m.exports;
  }

  /* ---------------- модуль wbclim-util ---------------- */
  __defs['wbclim-util'] = function (exports, module, require) {
    /**
     * @file wbclim-util.js
     * @description Утилиты климат-контроля: валидация чисел, фильтрация
     *              показаний датчиков, отбраковка выбросов, контроль связи
     *              по meta/error, группа датчиков помещения.
     *
     * Датчик (Sensor) и фильтр (Ema) перенесены из wb-mixing-groups
     * (wbmix-util.js) без изменения логики — кандидаты в общую библиотеку.
     *
     * Целевой рантайм: wb-rules 2.x (duktape, ECMAScript 5).
     * Никаких let/const/=>/шаблонных строк.
     */

    /* ------------------------------------------------------------------ */
    /*  Базовые хелперы                                                    */
    /* ------------------------------------------------------------------ */

    function clamp(v, lo, hi) {
      if (v < lo) return lo;
      if (v > hi) return hi;
      return v;
    }

    function isNum(v) {
      return typeof v === 'number' && isFinite(v);
    }

    /** Мягкое приведение значения из MQTT к числу. */
    function toNum(v) {
      if (v === null || v === undefined || v === '') return NaN;
      if (typeof v === 'number') return v;
      var n = parseFloat(v);
      return isFinite(n) ? n : NaN;
    }

    /** Округление до N знаков (для публикации в MQTT). */
    function round(v, digits) {
      if (!isNum(v)) return v;
      var k = Math.pow(10, digits === undefined ? 2 : digits);
      return Math.round(v * k) / k;
    }

    /**
     * Значение по умолчанию, если поле не задано.
     * Не годится там, где null несёт смысл («выключено»): null тоже
     * превращается в значение по умолчанию (wbmix, грабля №13).
     */
    function def(v, d) {
      return v === undefined || v === null ? d : v;
    }

    /**
     * Список топиков из конфигурации. Принимает строку, массив строк или
     * массив объектов { control: "устройство/контрол" } — так списки топиков
     * хранит форма настроек (таблица, как в штатных сценариях wb-scenarios).
     * Пустые строки отбрасываются: эталон поставляется с пустыми полями.
     */
    function topicList(v) {
      var src = Array.isArray(v) ? v : v ? [v] : [];
      var out = [];
      for (var i = 0; i < src.length; i++) {
        var t = src[i] && typeof src[i] === 'object' ? src[i].control : src[i];
        if (typeof t === 'string' && t !== '') out.push(t);
      }
      return out;
    }

    /**
     * Связь с контролом по meta/error.
     * @returns {string|null} причина отказа или null, если всё в порядке
     */
    function linkError(topic) {
      if (!topic) return 'не задан топик';
      var err = dev[topic + '#error'];
      if (err === null) return 'нет контрола ' + topic;
      if (err !== undefined && err !== '' && err !== false) return 'нет связи (' + topic + ': ' + err + ')';
      return null;
    }

    /* ------------------------------------------------------------------ */
    /*  Экспоненциальный фильтр первого порядка                            */
    /* ------------------------------------------------------------------ */

    /**
     * @param {number} tau постоянная времени фильтра, с (0 = фильтр выключен)
     */
    function Ema(tau) {
      this.tau = tau || 0;
      this.value = null;
    }

    Ema.prototype.push = function (x, dt) {
      if (!isNum(x)) return this.value;
      if (this.value === null || this.tau <= 0 || !isNum(dt)) {
        this.value = x;
        return this.value;
      }
      // Внеочередной такт (смена уставки) в тот же момент — фильтр не трогаем.
      // В wbmix здесь было «value = x», и такой такт обнулял сглаживание.
      if (dt <= 0) return this.value;
      var a = dt / (this.tau + dt);
      this.value = this.value + a * (x - this.value);
      return this.value;
    };

    Ema.prototype.reset = function () {
      this.value = null;
    };

    /* ------------------------------------------------------------------ */
    /*  Датчик                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Обёртка над MQTT-топиком датчика.
     *
     *   - проверяет наличие контрола и meta/error (обрыв 1-Wire, потеря Modbus);
     *   - отбраковывает значения вне физического диапазона;
     *   - отбраковывает выбросы (скачок быстрее maxRate единиц в секунду);
     *   - сглаживает показания фильтром первого порядка;
     *   - поднимает признак fault только после N подряд плохих чтений,
     *     чтобы одиночный сбой опроса не ронял зону в аварию.
     *
     * @param {string} topic  "device/control", например "wb-msw-v3_21/Temperature"
     * @param {Object} opts   { tau, min, max, maxRate, faultAfter, required }
     */
    function Sensor(topic, opts) {
      opts = opts || {};
      this.topic = topic || null;
      this.required = def(opts.required, true);
      this.min = def(opts.min, -60);
      this.max = def(opts.max, 150);
      this.maxRate = def(opts.maxRate, 2); // единиц/с
      this.faultAfter = def(opts.faultAfter, 3);
      this.ema = new Ema(def(opts.tau, 5));

      this.value = null; // отфильтрованное
      this.raw = null; // последнее принятое сырое
      this.badCount = 0;
      this.fault = false;
      this.reason = this.topic ? 'init' : 'not configured';
      this.configured = !!this.topic;
    }

    /**
     * Прочитать датчик.
     * @param {number} dt интервал с прошлого чтения, с
     * @returns {boolean} true, если значение валидно
     */
    Sensor.prototype.poll = function (dt) {
      if (!this.configured) {
        this.fault = this.required;
        return false;
      }

      var bad = null;
      var v = NaN;

      // 1. Существование контрола и признак ошибки шины
      var errMeta = dev[this.topic + '#error'];
      if (errMeta === null) {
        bad = 'no control';
      } else if (errMeta !== undefined && errMeta !== '' && errMeta !== false) {
        bad = 'bus error: ' + errMeta;
      } else {
        // 2. Значение и физический диапазон
        v = toNum(dev[this.topic]);
        if (!isNum(v)) bad = 'no value';
        else if (v < this.min || v > this.max) bad = 'out of range: ' + v;
        // 3. Отбраковка выбросов
        else if (
          this.raw !== null &&
          isNum(dt) &&
          dt > 0 &&
          Math.abs(v - this.raw) > this.maxRate * dt + 1
        ) {
          bad = 'spike: ' + this.raw + ' -> ' + v;
        }
      }

      if (bad !== null) {
        this.badCount++;
        this.reason = bad;
        if (this.badCount >= this.faultAfter) {
          this.fault = true;
          // после устойчивой аварии сбрасываем историю, чтобы после
          // восстановления датчик не считался «выбросом»
          this.raw = null;
          this.ema.reset();
          this.value = null;
        }
        return false;
      }

      this.badCount = 0;
      this.fault = false;
      this.reason = 'ok';
      this.raw = v;
      this.value = this.ema.push(v, dt);
      return true;
    };

    /** Значение или fallback, если датчик неисправен/не настроен. */
    Sensor.prototype.get = function (fallback) {
      return this.fault || this.value === null ? fallback : this.value;
    };

    Sensor.prototype.ok = function () {
      return !this.fault && this.value !== null;
    };

    /* ------------------------------------------------------------------ */
    /*  Группа датчиков                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Несколько датчиков одной величины в одном помещении: среднее по
     * исправным. Отказ части датчиков — предупреждение, зона работает на
     * оставшихся; отказ всех — авария.
     *
     * Среднее, а не минимум: датчик у окна или над конвектором и так
     * врёт в свою сторону, а минимум держал бы помещение перегретым.
     *
     * @param {Array|string} topics топики датчиков
     * @param {Object} opts параметры Sensor для каждого
     */
    function SensorSet(topics, opts) {
      var list = topicList(topics);
      this.sensors = [];
      for (var i = 0; i < list.length; i++) this.sensors.push(new Sensor(list[i], opts));
      this.configured = this.sensors.length > 0;
      this.value = null;
    }

    SensorSet.prototype.poll = function (dt) {
      var sum = 0;
      var n = 0;
      for (var i = 0; i < this.sensors.length; i++) {
        var s = this.sensors[i];
        s.poll(dt);
        if (s.ok()) {
          sum += s.value;
          n++;
        }
      }
      this.value = n > 0 ? sum / n : null;
      return n > 0;
    };

    SensorSet.prototype.ok = function () {
      return this.value !== null;
    };

    SensorSet.prototype.get = function (fallback) {
      return this.value === null ? fallback : this.value;
    };

    /** Описание неисправных датчиков (пустая строка — все в порядке). */
    SensorSet.prototype.faults = function () {
      var out = [];
      for (var i = 0; i < this.sensors.length; i++) {
        var s = this.sensors[i];
        if (s.fault) out.push(s.topic + ' (' + s.reason + ')');
      }
      return out.join(', ');
    };

    /* ------------------------------------------------------------------ */

    exports.clamp = clamp;
    exports.isNum = isNum;
    exports.toNum = toNum;
    exports.round = round;
    exports.def = def;
    exports.topicList = topicList;
    exports.linkError = linkError;
    exports.Ema = Ema;
    exports.Sensor = Sensor;
    exports.SensorSet = SensorSet;

  };

  /* ---------------- модуль wbclim-valve ---------------- */
  __defs['wbclim-valve'] = function (exports, module, require) {
    /**
     * @file wbclim-valve.js
     * @description Термоголовка (термоэлектрический сервопривод) на реле.
     *
     * Общий исполнитель для всего, что греет водой через клапан «открыт/закрыт»:
     * конвекторы, тёплый пол на коллекторе, радиаторы. Одна «термоголовка»
     * здесь — это группа реле, которые всегда переключаются вместе (например,
     * две петли пола в одном помещении).
     *
     * Свойства объекта, которые определяют логику:
     *
     *   1. Термоголовка медленная. От подачи напряжения до полного открытия
     *      2–4 минуты (нагрев воскового элемента), закрытие — столько же.
     *      Поэтому переключать её чаще, чем раз в пару минут, бессмысленно:
     *      клапан просто не успевает дойти. Минимальные времена «открыт» и
     *      «закрыт» — не прихоть, а физика привода.
     *
     *   2. Обратной связи по положению нет. «Клапан реально открыт» — это
     *      оценка по времени с момента команды (openTime). Ей пользуется
     *      вентилятор конвектора: дуть, пока теплообменник холодный, нельзя.
     *
     *   3. Бывают нормально закрытые (NC, обесточен — закрыт, основной случай)
     *      и нормально открытые (NO). Для NO реле включается, чтобы закрыть.
     *
     * Два режима:
     *
     *   onoff — двухпозиционный по потребности зоны: открыть при потребности
     *           не ниже onAt, закрыть при потребности не выше offAt (по
     *           умолчанию 0 — т. е. когда уставка достигнута).
     *   pwm   — широтно-импульсный: в каждом цикле (по умолчанию 15 мин)
     *           клапан открыт долю времени, равную потребности. Для тёплого
     *           пола и пассивных конвекторов даёт ровную температуру без
     *           раскачки.
     */

    var U = require('wbclim-util');

    /**
     * @param {Object} cfg
     *   topics        {Array}  реле термоголовок, например ["wb-mr6c_45/K1"]
     *   normallyOpen  {bool}   термоголовки NO (по умолчанию NC)
     *   mode          {string} "onoff" | "pwm"
     *   onAt, offAt   {number} пороги потребности для onoff, %
     *   minOn, minOff {number} минимальное время в открытом/закрытом, с
     *   cycle         {number} период ШИМ, с
     *   openTime      {number} время полного открытия термоголовки, с
     * @param {Object} ctx { log, id }
     */
    function ThermalValve(cfg, ctx) {
      cfg = cfg || {};
      ctx = ctx || {};
      this.log = ctx.log || log;
      this.id = ctx.id || 'valve';

      this.topics = U.topicList(cfg.topics);
      this.normallyOpen = !!cfg.normallyOpen;
      this.mode = cfg.mode === 'pwm' ? 'pwm' : 'onoff';
      this.onAt = U.def(cfg.onAt, 5);
      this.offAt = U.def(cfg.offAt, 0);
      this.minOnMs = U.def(cfg.minOn, 120) * 1000;
      this.minOffMs = U.def(cfg.minOff, 120) * 1000;
      this.cycleMs = U.def(cfg.cycle, 900) * 1000;
      this.openTimeMs = U.def(cfg.openTime, 180) * 1000;

      // Начальное состояние берём с реле, а не навязываем «закрыто».
      // После перезагрузки сценария (сохранение в веб-интерфейсе) клапан
      // уже открыт и прогрет — сбрасывать его и заново ждать прогрева,
      // останавливая вентилятор на 3 минуты, незачем.
      var first = this.topics.length ? dev[this.topics[0]] : undefined;
      var relayOn = first === true || first === 1 || first === '1';
      this.open = this.normallyOpen ? first === false || first === 0 || first === '0' : relayOn;
      var now = Date.now();
      // since — момент последнего переключения. Для уже открытого клапана
      // считаем, что он открыт давно: прогрев закончен.
      this.since = this.open ? now - this.openTimeMs : null;
      this.cycleStart = null;
      this.lastDemand = 0;
      this.switches = 0;
    }

    /** Состояние реле, соответствующее положению клапана. */
    ThermalValve.prototype._relayFor = function (open) {
      return this.normallyOpen ? !open : !!open;
    };

    /** Привести реле к нужному состоянию. Пишем, только если отличается. */
    ThermalValve.prototype._write = function () {
      var want = this._relayFor(this.open);
      for (var i = 0; i < this.topics.length; i++) {
        var t = this.topics[i];
        if (dev[t] === want) continue;
        try {
          dev[t] = want;
        } catch (e) {
          this.log.error('[{}] не удалось записать {}: {}', this.id, t, e);
        }
      }
    };

    ThermalValve.prototype._onoff = function (demand) {
      if (!this.open && demand >= this.onAt) return true;
      if (this.open && demand <= this.offAt) return false;
      return this.open;
    };

    /**
     * ШИМ: в каждом цикле клапан открыт долю времени, равную потребности.
     * Потребность пересчитывается каждый такт, так что изменение уставки
     * сказывается в текущем цикле, а не через 15 минут.
     */
    ThermalValve.prototype._pwm = function (demand, now) {
      var cyc = this.cycleMs;
      // Потребность появилась после простоя — цикл начинается сейчас,
      // иначе клапан ждал бы конца «пустого» цикла до 15 минут.
      if (this.cycleStart === null || now - this.cycleStart >= cyc || (this.lastDemand <= 0 && demand > 0)) {
        this.cycleStart = now;
      }
      var onMs = (U.clamp(demand, 0, 100) / 100) * cyc;
      // Импульс короче времени открытия термоголовки ничего не даст —
      // клапан не успеет открыться. Пауза короче минимальной — тоже.
      if (onMs < this.minOnMs) onMs = 0;
      else if (cyc - onMs < this.minOffMs) onMs = cyc;
      return now - this.cycleStart < onMs;
    };

    /**
     * Такт: отработать потребность.
     * @param {number} demand потребность зоны, %
     * @param {number} now    текущее время, мс
     * @param {bool}   force  переключить сразу, без учёта минимальных времён
     *                        (зону выключили, открыли окно)
     * @returns {bool} клапан открыт
     */
    ThermalValve.prototype.update = function (demand, now, force) {
      demand = U.isNum(demand) ? demand : 0;
      var want = this.mode === 'pwm' ? this._pwm(demand, now) : this._onoff(demand);
      this.lastDemand = demand;

      if (want !== this.open && !force && this.since !== null) {
        var minMs = this.open ? this.minOnMs : this.minOffMs;
        if (now - this.since < minMs) want = this.open;
      }
      if (want !== this.open) {
        this.open = want;
        this.since = now;
        this.switches++;
      }
      this._write();
      return this.open;
    };

    /** Сколько клапан открыт, мс (0 — закрыт). */
    ThermalValve.prototype.openFor = function (now) {
      if (!this.open) return 0;
      return this.since === null ? this.openTimeMs : now - this.since;
    };

    /** Термоголовка успела открыться полностью. */
    ThermalValve.prototype.isFullyOpen = function (now) {
      return this.openFor(now) >= this.openTimeMs;
    };

    ThermalValve.prototype.getFault = function () {
      for (var i = 0; i < this.topics.length; i++) {
        var e = U.linkError(this.topics[i]);
        if (e) return 'термоголовка: ' + e;
      }
      return null;
    };

    /** Закрыть немедленно. */
    ThermalValve.prototype.halt = function () {
      if (this.open) {
        this.open = false;
        this.since = Date.now();
      }
      this._write();
    };

    ThermalValve.prototype.outputs = function () {
      return this.topics.slice();
    };

    exports.ThermalValve = ThermalValve;

  };

  /* ---------------- модуль wbclim-fan ---------------- */
  __defs['wbclim-fan'] = function (exports, module, require) {
    /**
     * @file wbclim-fan.js
     * @description Вентилятор активного конвектора, фанкойла, вентустановки.
     *
     * Драйвер только выдаёт скорость на выходы. Какую скорость нужно —
     * решает исполнитель (конвектор) по потребности зоны.
     *
     * Один интерфейс — две реализации:
     *
     *   RelayFan  — 1–3 реле, по одному на скорость (отводы обмотки
     *               трёхскоростного двигателя). steps = числу реле.
     *               Режим exclusive (основной): включено не больше одного
     *               реле. При смене скорости старое реле выключается, новое
     *               включается после паузы interlock — два отвода обмотки,
     *               замкнутые одновременно хотя бы на миг, это межвитковое
     *               замыкание. Режим cumulative: для скорости N включены
     *               реле 1..N (встречается у ЕС-вентиляторов со ступенчатыми
     *               входами).
     *
     *   ValueFan  — числовой выход:
     *               analog — 0-10 В через WB-MAO4 (мВ 0..10000), плавно;
     *               modbus — регистр скорости конвектора со своим
     *                        контроллером (через шаблон wb-mqtt-serial):
     *                        ступени 0..N, ступени с заданными значениями
     *                        (values) или плавно в заданной шкале.
     *
     *               Плата конвектора может сохранять каждое записанное
     *               значение в энергонезависимую память (Varmann Vartronic
     *               так и делает). Плавная скорость, которая меняется
     *               каждый такт, — это тысячи записей в сутки, ресурс памяти
     *               кончится за недели. Поэтому плавное значение пишется,
     *               только если изменилось не меньше чем на minChange %;
     *               пуск, остановка и выход на 100 % — всегда.
     *
     * Общий интерфейс:
     *   .steps              число ступеней; 0 — плавное управление (0..100 %)
     *   .write(level, now)  выдать ступень (0..steps) или процент (steps = 0)
     *   .halt()             остановить
     *   .detach()           отпустить выходы как есть (перезагрузка сценария)
     *   .getFault()         связь с модулями выходов
     *   .outputs()          топики выходов (для проверки конфигурации)
     */

    var U = require('wbclim-util');

    function writeBool(topic, v, ctx) {
      if (!topic || dev[topic] === v) return;
      try {
        dev[topic] = v;
      } catch (e) {
        ctx.log.error('[{}] не удалось записать {}: {}', ctx.id, topic, e);
      }
    }

    /* ================================================================== */
    /*  Реле скоростей                                                     */
    /* ================================================================== */

    /**
     * @param {Object} cfg
     *   speeds    {Array}  реле скоростей от медленной к быстрой
     *   relayMode {string} "exclusive" | "cumulative"
     *   interlock {number} пауза между выключением одной скорости
     *                      и включением другой, мс
     *   enable    {string} опционально: реле питания вентилятора
     */
    function RelayFan(cfg, ctx) {
      this.ctx = ctx;
      this.topics = U.topicList(cfg.speeds);
      this.steps = this.topics.length;
      this.cumulative = cfg.relayMode === 'cumulative';
      this.interlockMs = U.def(cfg.interlock, 500);
      this.enable = cfg.enable || null;
      this.level = 0;
      this.pending = null; // ступень, ждущая окончания паузы
      this.startTimer = null;
      this.lastOff = null; // когда последний раз выключали реле скорости
    }

    RelayFan.prototype._want = function (i, level) {
      return this.cumulative ? i < level : i === level - 1;
    };

    RelayFan.prototype._cancel = function () {
      if (this.startTimer !== null) {
        clearTimeout(this.startTimer);
        this.startTimer = null;
      }
      this.pending = null;
    };

    RelayFan.prototype.write = function (level, now) {
      level = U.clamp(Math.round(U.isNum(level) ? level : 0), 0, this.steps);
      now = U.def(now, Date.now());
      // Эта же ступень уже ждёт паузы — не перезапускаем таймер
      if (this.pending === level && this.startTimer !== null) return;
      this._cancel();

      // Сначала снимаем всё лишнее
      for (var i = 0; i < this.topics.length; i++) {
        if (!this._want(i, level) && dev[this.topics[i]] !== false) {
          writeBool(this.topics[i], false, this.ctx);
          this.lastOff = now;
        }
      }
      writeBool(this.enable, level > 0, this.ctx);
      this.level = level;

      var ons = [];
      for (var j = 0; j < this.topics.length; j++) {
        if (this._want(j, level) && dev[this.topics[j]] !== true) ons.push(this.topics[j]);
      }
      if (!ons.length) return;

      var self = this;
      var fire = function () {
        self.startTimer = null;
        self.pending = null;
        for (var k = 0; k < ons.length; k++) writeBool(ons[k], true, self.ctx);
      };
      // В режиме exclusive новая скорость включается не раньше чем через
      // interlock после выключения прежней. Таймер хранится: halt() в эту
      // паузу обязан его отменить (wbmix, грабля №15).
      var wait = this.cumulative || this.lastOff === null ? 0 : this.interlockMs - (now - this.lastOff);
      if (wait > 0) {
        this.pending = level;
        this.startTimer = setTimeout(fire, wait);
      } else fire();
    };

    RelayFan.prototype.halt = function () {
      this._cancel();
      for (var i = 0; i < this.topics.length; i++) writeBool(this.topics[i], false, this.ctx);
      writeBool(this.enable, false, this.ctx);
      this.level = 0;
      this.lastOff = Date.now();
    };

    /** Отпустить выходы как есть, отменив отложенное включение. */
    RelayFan.prototype.detach = function () {
      this._cancel();
    };

    RelayFan.prototype.getFault = function () {
      var all = this.outputs();
      for (var i = 0; i < all.length; i++) {
        var e = U.linkError(all[i]);
        if (e) return 'вентилятор: ' + e;
      }
      return null;
    };

    RelayFan.prototype.outputs = function () {
      var o = this.topics.slice();
      if (this.enable) o.push(this.enable);
      return o;
    };

    /* ================================================================== */
    /*  Числовой выход: 0-10 В, регистр Modbus                             */
    /* ================================================================== */

    /**
     * @param {Object} cfg
     *   out       {string} топик выхода
     *   steps     {number} ступеней (0 — плавно)
     *   values    {Array}  значения ступеней 1..N, напр. [30, 60, 100];
     *                      задано — число ступеней берётся отсюда
     *   minChange {number} плавно: не писать изменения меньше, %
     *   valueOff  {number} значение «стоп»
     *   valueMin  {number} значение при 0 % (для плавного), напр. 2000 для 2-10 В
     *   valueMax  {number} значение при 100 %
     *   enable    {string} опционально: реле питания вентилятора
     */
    function ValueFan(cfg, ctx, defaults) {
      this.ctx = ctx;
      this.out = cfg.out || null;
      this.steps = Math.max(0, Math.round(U.def(cfg.steps, defaults.steps)));
      this.values = null;
      if (Array.isArray(cfg.values) && cfg.values.length) {
        this.values = [];
        for (var i = 0; i < cfg.values.length; i++) this.values.push(U.toNum(cfg.values[i]));
        this.steps = this.values.length;
      }
      this.minChange = U.def(cfg.minChange, defaults.minChange);
      this.sent = null; // плавно: уровень, записанный последним
      this.valueOff = U.def(cfg.valueOff, 0);
      this.valueMin = U.def(cfg.valueMin, defaults.valueMin);
      this.valueMax = U.def(cfg.valueMax, defaults.valueMax);
      this.enable = cfg.enable || null;
      this.level = 0;
      // null, а не 0: иначе первая команда «0» не запишется, и после
      // рестарта на выходе останется старое значение (wbmix, грабля №4)
      this.cmd = null;
      this.lastWrite = null;
    }

    ValueFan.prototype._raw = function (level) {
      if (level <= 0) return this.valueOff;
      if (this.steps > 0) return this.values ? this.values[level - 1] : level;
      var v = this.valueMin + ((this.valueMax - this.valueMin) * level) / 100;
      return Math.abs(this.valueMax - this.valueMin) >= 100 ? Math.round(v) : U.round(v, 2);
    };

    ValueFan.prototype.write = function (level, now) {
      now = U.def(now, Date.now());
      level = U.isNum(level) ? level : 0;
      level = this.steps > 0 ? U.clamp(Math.round(level), 0, this.steps) : U.clamp(level, 0, 100);
      // Плавно: мелкие изменения не пишем, держим записанное
      if (this.steps === 0 && this.sent !== null && this.sent > 0 && level > 0 && level < 100) {
        if (Math.abs(level - this.sent) < this.minChange) level = this.sent;
      }
      var raw = this._raw(level);
      // Значение пишем при изменении, а также раз в минуту, если модуль
      // показывает не то, что мы записали (перезапустился после пропадания
      // питания и вернул выход в безопасное состояние).
      var actual = U.toNum(dev[this.out]);
      // Ступени сравниваются точно: номер ступени 1 и 2 отличаются на 1,
      // а 2 % шкалы 0..100 — это 2, и сброс ступени остался бы незамеченным
      var tol = this.steps > 0 ? 0.5 : Math.max(Math.abs(this.valueMax - this.valueMin) * 0.02, 0.01);
      var drift = U.isNum(actual) && Math.abs(actual - raw) > tol;
      if (raw !== this.cmd || (drift && (this.lastWrite === null || now - this.lastWrite >= 60000))) {
        try {
          dev[this.out] = raw;
          this.cmd = raw;
          this.lastWrite = now;
          this.sent = level;
        } catch (e) {
          this.ctx.log.error('[{}] не удалось записать {}: {}', this.ctx.id, this.out, e);
        }
      }
      writeBool(this.enable, level > 0, this.ctx);
      this.level = level;
    };

    ValueFan.prototype.halt = function () {
      this.write(0);
    };

    ValueFan.prototype.detach = function () {};

    ValueFan.prototype.getFault = RelayFan.prototype.getFault;

    ValueFan.prototype.outputs = function () {
      var o = this.out ? [this.out] : [];
      if (this.enable) o.push(this.enable);
      return o;
    };

    /* ================================================================== */

    var VALUE_DEFAULTS = {
      // WB-MAO4: канал в милливольтах 0..10000
      analog: { steps: 0, valueMin: 0, valueMax: 10000, minChange: 1 },
      // Типовой регистр скорости: 0 — стоп, 1..3 — скорости.
      // minChange 5 % — по стенду test/sim.js (см. PROMPT.md, раздел 8)
      modbus: { steps: 3, valueMin: 0, valueMax: 100, minChange: 5 }
    };

    /** Есть ли вентилятор в описании. */
    function present(cfg) {
      return !!(cfg && cfg.type && cfg.type !== 'none');
    }

    /**
     * Фабрика по cfg.type: "relays" | "analog" | "modbus".
     * @returns {Object|null} null, если вентилятора нет
     */
    function create(cfg, ctx) {
      if (!present(cfg)) return null;
      ctx = ctx || {};
      ctx.log = ctx.log || log;
      ctx.id = ctx.id || 'fan';
      if (cfg.type === 'relays') return new RelayFan(cfg, ctx);
      if (VALUE_DEFAULTS[cfg.type]) return new ValueFan(cfg, ctx, VALUE_DEFAULTS[cfg.type]);
      throw new Error('wbclim: неизвестный тип вентилятора: ' + cfg.type);
    }

    /** Незаполненные обязательные поля вентилятора. */
    function missingOf(cfg) {
      if (!present(cfg)) return [];
      if (cfg.type === 'relays') return U.topicList(cfg.speeds).length ? [] : ['реле скоростей вентилятора'];
      return cfg.out ? [] : ['выход вентилятора'];
    }

    /** Все выходы вентилятора по конфигурации — без создания драйвера. */
    function outputsOf(cfg) {
      if (!present(cfg)) return [];
      var o = cfg.type === 'relays' ? U.topicList(cfg.speeds) : U.topicList(cfg.out);
      if (cfg.enable) o.push(cfg.enable);
      return o;
    }

    exports.create = create;
    exports.present = present;
    exports.missingOf = missingOf;
    exports.outputsOf = outputsOf;
    exports.RelayFan = RelayFan;
    exports.ValueFan = ValueFan;

  };

  /* ---------------- модуль wbclim-convector ---------------- */
  __defs['wbclim-convector'] = function (exports, module, require) {
    /**
     * @file wbclim-convector.js
     * @description Исполнитель «Конвектор»: термоголовка + вентилятор.
     *
     * Получает от зоны потребность в тепле 0..100 % и раскладывает её
     * на свои выходы:
     *
     *   потребность   0 %  ─ уставка достигнута ─────────── клапан закрыт
     *               > 0 %  ─ тепло нужно ───────────────── клапан открыт,
     *                                                      греет естественной
     *                                                      конвекцией
     *          ≥ fanStart  ─ естественной конвекции мало ─ вентилятор на
     *                                                      первой скорости
     *              100 %   ─ сильное отставание ─────────── максимальная скорость
     *
     * Чем больше разница между уставкой и температурой, тем выше потребность
     * и тем быстрее вентилятор. На подходе к уставке скорость падает до нуля,
     * при достижении уставки закрывается термоголовка.
     *
     * Простой (пассивный) конвектор — тот же исполнитель без вентилятора:
     * управляется только термоголовкой, как тёплый пол.
     *
     * Защита от холодного дутья. Вентилятор не включается, пока
     * теплообменник не прогрелся: по датчику воды (если задан) — от
     * minWater, иначе — через delay после открытия термоголовки
     * (термоголовке нужно 2–4 минуты, чтобы открыться, и ещё время, чтобы
     * дошла горячая вода). Иначе первым делом в комнату дует холодный воздух.
     *
     * Ступени вентилятора. Пороги равномерно делят диапазон потребности
     * fanStart..100 %. Переключение вверх — сразу по достижении порога,
     * вниз — с гистерезисом hyst. Между переключениями ступеней выдерживается
     * minStepTime: датчик температуры шумит, и без этого реле скоростей
     * щёлкали бы на каждом такте. Пуск с нуля и остановка — без задержки.
     *
     * Скорость по разнице температур (speedBy: "delta", по умолчанию для
     * реле скоростей — пользователь на стенде: «скорость вентилятора привязать
     * к разнице градусов между уставкой и реальной, с градацией 2 градуса»).
     * Разница = уставка − температура, шаг deltaStep (2 °C):
     *
     *   разница ≤ 0          ─ клапан закрыт, вентилятор стоит
     *   0 … шаг              ─ скорость 1
     *   шаг … 2·шаг          ─ скорость 2
     *   от 2·шага            ─ скорость 3 (последняя)
     *
     * Вверх — сразу за порогом, вниз — на deltaHyst ниже порога: вентилятор
     * останавливается, когда в комнате на deltaHyst теплее уставки.
     * Клапан открыт, пока скорость не ноль. Потребность помещения и роль
     * прибора (догрев при поле) в этом режиме не участвуют — по выбору
     * пользователя, шкала одна и с полом. Только в режиме «Авто» при
     * исправных датчиках: ручная потребность, защита от замерзания, отказ
     * датчиков, окно и выключенное помещение работают по потребности, как
     * раньше. Плавный вентилятор (0-10 В, Modbus без ступеней) — линейно
     * от min на нуле до max на трёх шагах.
     */

    var U = require('wbclim-util');
    var VALVE = require('wbclim-valve');
    var FAN = require('wbclim-fan');

    /**
     * @param {Object} cfg описание конвектора (см. README):
     *   id, title, valve{...}, fan{type, ..., start, min, max, hyst,
     *   minStepTime, delay, minWater}, waterSensor
     * @param {Object} ctx { log, id }
     */
    function Convector(cfg, ctx) {
      cfg = cfg || {};
      ctx = ctx || {};
      this.id = cfg.id;
      this.title = cfg.title || cfg.id;
      this.log = ctx.log || log;
      var tag = (ctx.id ? ctx.id + '/' : '') + this.id;

      var v = cfg.valve || {};
      this.valve = new VALVE.ThermalValve(v, { log: this.log, id: tag });

      var f = cfg.fan || {};
      this.fan = FAN.create(f, { log: this.log, id: tag });
      this.fanStart = U.clamp(U.def(f.start, 20), 0, 95);
      this.fanMin = U.clamp(U.def(f.min, 20), 0, 100);
      this.fanMax = U.clamp(U.def(f.max, 100), this.fanMin, 100);
      // 10 %, а не 5: на стенде (test/sim.js) переключений ступеней в час
      // меньше на четверть при том же размахе температуры
      this.fanHyst = U.def(f.hyst, 10);
      this.fanStepMs = U.def(f.minStepTime, 60) * 1000;
      // По умолчанию вентилятор ждёт полного открытия термоголовки
      this.fanDelayMs = U.def(f.delay, U.def(v.openTime, 180)) * 1000;
      this.waterMin = U.def(f.minWater, 30);
      this.speedBy = f.speedBy === 'delta' || f.speedBy === 'demand' ? f.speedBy : f.type === 'relays' ? 'delta' : 'demand';
      this.deltaStep = U.clamp(U.def(f.deltaStep, 2), 0.5, 10);
      this.deltaHyst = U.clamp(U.def(f.deltaHyst, 0.3), 0, 1);
      this.dLevel = 0; // ступень по разнице, с гистерезисом; у плавного — 0/1
      this.delta = null; // разница, если скорость сейчас по ней
      this.waterHyst = 3;

      this.water = cfg.waterSensor
        ? new U.Sensor(cfg.waterSensor, { tau: 10, min: -20, max: 110, required: false, maxRate: 2 })
        : null;
      this.warm = false; // гистерезис по датчику воды

      this.level = 0; // ступень или % вентилятора
      this.levelTs = null;
      this.blocked = ''; // почему вентилятор не работает при потребности
    }

    Convector.prototype.hasFan = function () {
      return this.fan !== null;
    };

    /** Теплообменник прогрет — можно дуть. */
    Convector.prototype._isWarm = function (now) {
      if (this.water && this.water.ok()) {
        var t = this.water.value;
        if (t >= this.waterMin) this.warm = true;
        else if (t < this.waterMin - this.waterHyst) this.warm = false;
        return this.warm;
      }
      // Датчика воды нет или он неисправен — по времени открытия клапана
      return this.valve.openFor(now) >= this.fanDelayMs;
    };

    /** Скорость по потребности: ступень 0..N или процент. */
    Convector.prototype._fanTarget = function (demand) {
      var start = this.fanStart;
      var n = this.fan.steps;
      if (n > 0) {
        var lvl = this.level;
        var thr = function (k) {
          return start + ((k - 1) * (100 - start)) / n;
        };
        while (lvl < n && demand >= thr(lvl + 1)) lvl++;
        while (lvl > 0 && demand < thr(lvl) - this.fanHyst) lvl--;
        return lvl;
      }
      var running = this.level > 0;
      if (demand < (running ? start - this.fanHyst : start)) return 0;
      var x = U.clamp((demand - start) / (100 - start), 0, 1);
      return Math.round(this.fanMin + (this.fanMax - this.fanMin) * x);
    };

    /**
     * Ступень по разнице «уставка − температура». Пороги ступени k —
     * (k − 1)·шаг: вверх, когда разница больше порога, вниз — когда не больше
     * порога минус гистерезис. Плавный вентилятор: вкл/выкл так же, как
     * ступень 1, скорость — от min до max на трёх шагах.
     */
    Convector.prototype._deltaTarget = function (delta) {
      var step = this.deltaStep;
      var h = this.deltaHyst;
      var n = this.fan.steps > 0 ? this.fan.steps : 1;
      var lvl = this.dLevel;
      while (lvl < n && delta > lvl * step) lvl++;
      while (lvl > 0 && delta <= (lvl - 1) * step - h) lvl--;
      this.dLevel = lvl;
      if (this.fan.steps > 0 || lvl === 0) return lvl;
      var x = U.clamp(delta / (3 * step), 0, 1);
      return Math.round(this.fanMin + (this.fanMax - this.fanMin) * x);
    };

    /**
     * Такт.
     * @param {number} demand потребность зоны, %
     * @param {number} now    мс
     * @param {number} dt     с с прошлого такта
     * @param {bool}   force  переключить клапан без учёта минимальных времён
     * @param {Object} [info] { setpoint, temperature, auto } от помещения
     */
    Convector.prototype.update = function (demand, now, dt, force, info) {
      if (this.water) this.water.poll(dt);
      var byDelta =
        this.fan !== null &&
        this.speedBy === 'delta' &&
        !!info &&
        info.auto === true &&
        U.isNum(info.setpoint) &&
        U.isNum(info.temperature);
      var want = 0;
      if (byDelta) {
        this.delta = info.setpoint - info.temperature;
        want = this._deltaTarget(this.delta);
        demand = want > 0 ? 100 : 0;
      } else {
        this.delta = null;
        this.dLevel = 0;
      }
      var open = this.valve.update(demand, now, force);
      if (!this.fan) return;

      var target = 0;
      this.blocked = '';
      if (open) {
        if (!byDelta) want = this._fanTarget(demand);
        if (want > 0 && !this._isWarm(now)) {
          this.blocked = this.water && this.water.ok() ? 'water' : 'delay';
        } else target = want;
      }

      // Выдержка между ступенями. Пуск и остановка — сразу.
      if (
        this.fan.steps > 0 &&
        target !== this.level &&
        target > 0 &&
        this.level > 0 &&
        this.levelTs !== null &&
        now - this.levelTs < this.fanStepMs
      ) {
        target = this.level;
      }
      if (target !== this.level) {
        this.level = target;
        this.levelTs = now;
      }
      this.fan.write(this.level, now);
    };

    /** Текст состояния для карточки устройства. */
    Convector.prototype.statusText = function (now) {
      if (!this.valve.open) return 'клапан закрыт';
      var s = 'клапан открыт';
      if (!this.fan) return s;
      if (this.blocked === 'delay') {
        var left = Math.max(0, Math.ceil((this.fanDelayMs - this.valve.openFor(now)) / 60000));
        return s + ', прогрев теплообменника (~' + left + ' мин)';
      }
      if (this.blocked === 'water') {
        return s + ', ждёт горячую воду (' + U.round(this.water.value, 1) + ' < ' + this.waterMin + ' °C)';
      }
      // уровень драйвера: плавный вентилятор может держать записанное значение
      var lvl = this.fan.level;
      var d = this.delta !== null ? ' (разница ' + U.round(this.delta, 1) + ' °C)' : '';
      if (lvl <= 0) return s + ', вентилятор стоит' + d;
      return s + ', вентилятор ' + (this.fan.steps > 0 ? 'скорость ' + lvl : Math.round(lvl) + ' %') + d;
    };

    /** Значения контролов на карточке помещения. */
    Convector.prototype.publish = function (set, now) {
      set('valve', this.valve.open);
      if (this.fan) set('fan', U.round(this.fan.level, 0));
      if (this.water) set('water', U.round(this.water.get(0), 1));
      set('status', this.statusText(now));
    };

    Convector.prototype.getFault = function () {
      return this.valve.getFault() || (this.fan ? this.fan.getFault() : null);
    };

    /** Предупреждения, не останавливающие работу. */
    Convector.prototype.getWarning = function () {
      if (this.water && this.water.fault) {
        return 'датчик воды ' + this.water.topic + ' (' + this.water.reason + '), вентилятор по таймеру';
      }
      return null;
    };

    /** Перезагрузка сценария: выходы остаются как есть, таймеры отменяются. */
    Convector.prototype.detach = function () {
      if (this.fan) this.fan.detach();
    };

    Convector.prototype.halt = function () {
      if (this.fan) this.fan.halt();
      this.level = 0;
      this.dLevel = 0;
      this.valve.halt();
    };

    /* ================================================================== */

    /** Контролы на карточке помещения: [{ name, spec, units }]. */
    function controlsOf(cfg, title) {
      var list = [
        {
          name: 'valve',
          spec: { title: { en: title + ': valve', ru: title + ': клапан' }, type: 'switch', value: false, readonly: true }
        }
      ];
      var f = cfg.fan;
      if (FAN.present(f)) {
        var stepped =
          f.type === 'relays' || (f.type === 'modbus' && (U.def(f.steps, 3) > 0 || (Array.isArray(f.values) && f.values.length > 0)));
        list.push({
          name: 'fan',
          spec: { title: { en: title + ': fan', ru: title + ': вентилятор' }, type: 'value', value: 0 },
          units: stepped ? null : '%'
        });
      }
      if (cfg.waterSensor) {
        list.push({
          name: 'water',
          spec: { title: { en: title + ': water', ru: title + ': вода' }, type: 'value', value: 0 },
          units: 'deg C'
        });
      }
      list.push({
        name: 'status',
        spec: { title: { en: title + ': status', ru: title + ': состояние' }, type: 'text', value: '' }
      });
      return list;
    }

    /** Незаполненные обязательные поля. */
    function missingOf(cfg) {
      var miss = [];
      if (!U.topicList(cfg.valve && cfg.valve.topics).length) miss.push('термоголовка');
      return miss.concat(FAN.missingOf(cfg.fan));
    }

    /** Выходы конвектора по конфигурации. */
    function outputsOf(cfg) {
      var out = [];
      var v = U.topicList(cfg.valve && cfg.valve.topics);
      for (var i = 0; i < v.length; i++) out.push({ topic: v[i], name: 'термоголовка' });
      var f = FAN.outputsOf(cfg.fan);
      for (var j = 0; j < f.length; j++) out.push({ topic: f[j], name: 'вентилятор' });
      return out;
    }

    exports.Convector = Convector;
    exports.controlsOf = controlsOf;
    exports.missingOf = missingOf;
    exports.outputsOf = outputsOf;

  };

  /* ---------------- модуль wbclim-floor ---------------- */
  __defs['wbclim-floor'] = function (exports, module, require) {
    /**
     * @file wbclim-floor.js
     * @description Исполнитель «Тёплый пол»: термоголовки петель на коллекторе,
     *              регулирование по датчикам пола.
     *
     * КАСКАД. Помещение (внешний контур) считает потребность в тепле по
     * воздуху. Пол (внутренний контур) превращает её в ЦЕЛЕВУЮ ТЕМПЕРАТУРУ
     * ПОЛА и держит её по своим датчикам:
     *
     *   цель = низ + (maxFloor − низ) · потребность / 100
     *   низ  = minFloor, если задан, иначе уставка помещения
     *
     *   - помещению тепло (потребность 0) — петли закрыты, пол остывает, но
     *     не ниже minFloor («пол не ниже»): ниже — петли открываются;
     *   - minFloor держится ВСЕГДА: и при выключенном помещении, и при
     *     открытом окне (решение пользователя 2026-10-02). Сильнее него только
     *     перегрев. Выключить пол совсем (лето) — «пол не ниже» = 0;
     *   - minFloor правится на карточке помещения (контрол <id>_min_floor),
     *     значение из настроек — начальное;
     *   - помещению холодно — цель растёт до maxFloor; выше пол не поднимается
     *     никогда (по умолчанию 29 °C — EN 1264 для жилых помещений;
     *     СП 60.13330 для постоянного пребывания — не выше 26 °C);
     *   - minFloor = maxFloor — пол просто держит заданную температуру,
     *     уставка помещения на него не влияет;
     *   - minFloor не задан — низ равен уставке помещения: пол, равный по
     *     температуре воздуху, тепла не отдаёт.
     *
     * Почему каскад, а не ШИМ по потребности помещения: стяжка копит тепло
     * часами, и регулятор по воздуху видит результат своих действий с большим
     * опозданием. Датчик в стяжке видит его в разы раньше — внутренний контур
     * гасит инерцию пола, а внешнему остаётся медленно подбирать нужную
     * температуру пола. И ограничения пола (мин/макс) получаются естественно.
     *
     * Внутренний контур — двухпозиционный по температуре пола с гистерезисом
     * floorHyst (по умолчанию 0,5 К: открыть ниже цели на 0,25 К, закрыть выше
     * на 0,25 К) с минимальными временами термоголовки. На стенде 0,5 К держит
     * помещение вдвое точнее, чем 1 К, при том же числе переключений.
     *
     * Нет датчиков пола или все отказали — ШИМ по потребности помещения
     * (цикл 20 мин), отказ — предупреждение на карточке.
     */

    var U = require('wbclim-util');
    var VALVE = require('wbclim-valve');

    /**
     * Термоголовки пола работают в режиме ШИМ: по датчику пола им подаётся
     * 0 или 100 % (закрыть / открыть), без датчика — потребность помещения.
     * Цикл и минимальные времена — по стенду test/sim.js (PROMPT.md, раздел 8).
     */
    var VALVE_DEFAULTS = { mode: 'pwm', cycle: 1200, minOn: 180, minOff: 180, openTime: 180 };

    /**
     * @param {Object} cfg описание (см. README):
     *   id, title, valve{topics, normallyOpen, cycle, minOn, minOff, openTime},
     *   floorSensors, minFloor, maxFloor, floorHyst
     * @param {Object} ctx { log, id }
     */
    function Floor(cfg, ctx) {
      cfg = cfg || {};
      ctx = ctx || {};
      this.id = cfg.id;
      this.title = cfg.title || cfg.id;
      this.log = ctx.log || log;
      var tag = (ctx.id ? ctx.id + '/' : '') + this.id;

      var v = {};
      var k;
      for (k in VALVE_DEFAULTS) if (Object.prototype.hasOwnProperty.call(VALVE_DEFAULTS, k)) v[k] = VALVE_DEFAULTS[k];
      var src = cfg.valve || {};
      for (k in src) if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== null && src[k] !== undefined) v[k] = src[k];
      v.mode = 'pwm'; // см. VALVE_DEFAULTS: и каскад, и запасной режим идут через ШИМ
      this.valve = new VALVE.ThermalValve(v, { log: this.log, id: tag });

      // Стяжка меняется медленно: 0,1 К/с отсекает мусор с шины с запасом
      this.floors = new U.SensorSet(cfg.floorSensors, { tau: 60, min: -20, max: 70, maxRate: 0.1 });
      this.maxFloor = U.def(cfg.maxFloor, 29);
      this.minFloorCfg = U.def(cfg.minFloor, 0); // 0 — низ по уставке помещения
      this.minFloor = this.minFloorCfg; // действующее: с карточки
      this.paused = false; // помещение выключено или открыто окно
      this.hyst = U.def(cfg.floorHyst, 0.5);

      this.heating = false; // решение внутреннего контура
      this.target = null; // целевая температура пола
      this.temp = null; // средняя по датчикам пола
      this.mode = 'pwm'; // cascade | pwm (запасной)
      this.limit = false;

      this.fan = null;
      this.level = 0;
    }

    Floor.prototype.hasFan = function () {
      return false;
    };

    /** «Пол не ниже» с карточки помещения; нет контрола — из настроек. */
    Floor.prototype._min = function (zone) {
      var v = zone && zone.get ? U.toNum(zone.get('min_floor')) : NaN;
      return U.clamp(U.isNum(v) ? v : this.minFloorCfg, 0, this.maxFloor);
    };

    /** Целевая температура пола по доле потребности. */
    Floor.prototype._target = function (demand, zone) {
      var hi = this.maxFloor;
      var lo = this.minFloor > 0 ? this.minFloor : zone && U.isNum(zone.setpoint) ? zone.setpoint : 20;
      lo = Math.min(lo, hi);
      return lo + ((hi - lo) * U.clamp(demand, 0, 100)) / 100;
    };

    /**
     * Такт.
     * @param {number} demand доля потребности зоны для пола, %
     * @param {number} now    мс
     * @param {number} dt     с с прошлого такта
     * @param {bool}   force  зона выключена или открыто окно: регулирование
     *                        по воздуху стоит, пол держит только minFloor
     * @param {Object} zone   { setpoint, get(name) } — уставка помещения и
     *                        чтение своих контролов на карточке
     */
    Floor.prototype.update = function (demand, now, dt, force, zone) {
      var d = U.isNum(demand) ? demand : 0;
      this.floors.poll(dt);
      this.temp = this.floors.get(null);
      this.minFloor = this._min(zone);
      this.paused = !!force;

      if (this.temp === null) {
        // Датчиков пола нет или все отказали — ШИМ по потребности помещения.
        // Держать минимум не по чему: на паузе петли закрыты.
        this.mode = 'pwm';
        this.target = null;
        this.heating = false;
        this.limit = false;
        this.valve.update(force ? 0 : d, now, !!force);
        return;
      }

      this.mode = 'cascade';
      if (force) {
        if (this.minFloor <= 0) {
          this.target = null;
          this.heating = false;
          this.limit = false;
          this.valve.update(0, now, true);
          return;
        }
        this.target = this.minFloor;
      } else {
        this.target = this._target(d, zone);
      }
      var t = this.temp;
      var half = this.hyst / 2;
      if (!this.heating && t < this.target - half) this.heating = true;
      else if (this.heating && t > this.target + half) this.heating = false;

      // Жёсткий предел — закрыть сразу, без выдержки минимального времени.
      // На паузе (выключено, окно) пол выше минимума тоже закрывается сразу.
      this.limit = t >= this.maxFloor;
      if (this.limit) this.heating = false;
      this.valve.update(this.heating ? 100 : 0, now, this.limit || (force && !this.heating));
    };

    Floor.prototype.statusText = function () {
      var s = this.valve.open ? 'петли открыты' : 'петли закрыты';
      if (this.paused && this.target === null) {
        var noData = this.mode === 'pwm' && this.floors.configured;
        return s + ', помещение на паузе' + (noData ? '; нет данных датчиков пола — минимум не держится' : '');
      }
      if (this.mode === 'pwm' || this.target === null) {
        return this.floors.configured ? s + ', нет данных датчиков пола — ШИМ по помещению' : s + ', ШИМ по помещению';
      }
      if (this.paused) {
        s += ', помещение на паузе — пол ' + U.round(this.temp, 1) + ' °C, держу не ниже ' + U.round(this.target, 1) + ' °C';
      } else {
        s += ', пол ' + U.round(this.temp, 1) + ' °C, цель ' + U.round(this.target, 1) + ' °C';
      }
      if (this.limit) s += ' — ограничение ' + this.maxFloor + ' °C';
      return s;
    };

    /** Значения контролов на карточке помещения. */
    Floor.prototype.publish = function (set, now) {
      set('valve', this.valve.open);
      if (this.floors.configured) {
        set('floor', this.temp === null ? 0 : U.round(this.temp, 1));
        set('target', this.target === null ? 0 : U.round(this.target, 1));
        // значение с карточки вне 0..maxFloor показываем исправленным
        set('min_floor', U.round(this.minFloor, 1));
      }
      set('status', this.statusText(now));
    };

    Floor.prototype.getFault = function () {
      return this.valve.getFault();
    };

    Floor.prototype.getWarning = function () {
      if (!this.floors.configured) return null;
      var f = this.floors.faults();
      if (!f) return null;
      return this.floors.ok()
        ? 'неисправен датчик пола ' + f + ', работаю по остальным'
        : 'нет данных датчиков пола: ' + f + ' — ШИМ по помещению, ограничение пола не работает';
    };

    Floor.prototype.detach = function () {};

    Floor.prototype.halt = function () {
      this.valve.halt();
    };

    /* ================================================================== */

    /** Контролы на карточке помещения: [{ name, spec, units }]. */
    function controlsOf(cfg, title) {
      var list = [
        {
          name: 'valve',
          spec: { title: { en: title + ': loops', ru: title + ': петли' }, type: 'switch', value: false, readonly: true }
        }
      ];
      if (U.topicList(cfg.floorSensors).length) {
        list.push({
          name: 'floor',
          spec: { title: { en: title + ': floor', ru: title + ': пол' }, type: 'value', value: 0 },
          units: 'deg C'
        });
        list.push({
          name: 'target',
          spec: { title: { en: title + ': floor target', ru: title + ': цель для пола' }, type: 'value', value: 0 },
          units: 'deg C'
        });
        // «Пол не ниже» правит хозяин на карточке; из настроек — начальное
        list.push({
          name: 'min_floor',
          spec: {
            title: { en: title + ': floor min (0 = by setpoint)', ru: title + ': пол не ниже (0 — по уставке)' },
            type: 'value',
            readonly: false,
            value: U.def(cfg.minFloor, 0),
            min: 0,
            max: 35
          },
          units: 'deg C',
          writable: true
        });
      }
      list.push({
        name: 'status',
        spec: { title: { en: title + ': status', ru: title + ': состояние' }, type: 'text', value: '' }
      });
      return list;
    }

    function missingOf(cfg) {
      return U.topicList(cfg.valve && cfg.valve.topics).length ? [] : ['термоголовки петель'];
    }

    /** Заданные, но противоречивые параметры. */
    function checkOf(cfg) {
      var lo = U.def(cfg.minFloor, 0);
      var hi = U.def(cfg.maxFloor, 29);
      return lo > hi ? ['минимум пола ' + lo + ' °C выше максимума ' + hi + ' °C'] : [];
    }

    function outputsOf(cfg) {
      var out = [];
      var v = U.topicList(cfg.valve && cfg.valve.topics);
      for (var i = 0; i < v.length; i++) out.push({ topic: v[i], name: 'термоголовка петли' });
      return out;
    }

    exports.Floor = Floor;
    exports.controlsOf = controlsOf;
    exports.missingOf = missingOf;
    exports.checkOf = checkOf;
    exports.outputsOf = outputsOf;
    exports.VALVE_DEFAULTS = VALVE_DEFAULTS;

  };

  /* ---------------- модуль wbclim-zone ---------------- */
  __defs['wbclim-zone'] = function (exports, module, require) {
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
     *   - открытое окно — отопление на паузе, интегратор заморожен
     *     (тёплый пол и на паузе держит «пол не ниже»);
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
        prefix: 'conv',
        speed: 'fast'
      },
      floor: {
        make: FLOOR.Floor,
        controlsOf: FLOOR.controlsOf,
        missingOf: FLOOR.missingOf,
        checkOf: FLOOR.checkOf,
        outputsOf: FLOOR.outputsOf,
        name: 'Тёплый пол',
        prefix: 'floor',
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

    /* ================================================================== */
    /*  Номера помещений и приборов                                        */
    /* ================================================================== */

    function shallowCopy(o) {
      var r = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
      return r;
    }

    /**
     * Пустые id и названия присваиваются сами — по номеру в списке, так же,
     * как их показывает форма: заголовок второго прибора без названия —
     * «Конвектор 2» (шаблон headerTemplate в tools/make-schema.js), и на
     * карточке он тоже «Конвектор 2», id conv2. Если номер уже занят
     * вручную заданным id — следующий свободный (conv2 занят — conv3).
     *
     * Зачем в коде, а не в форме: редактор формы (json-editor) не умеет
     * нумеровать элементы массива — «+ Прибор» подставлял второму прибору те
     * же conv1 / «Конвектор 1», что и первому, и помещение не запускалось.
     * Дубли, введённые вручную, по-прежнему ошибка: молча переименовывать
     * то, что человек написал сам, нельзя.
     *
     * @param {Array} list помещения или приборы одного помещения (меняется)
     * @param {Function} prefixOf элемент -> префикс id
     * @param {Function} nameOf элемент -> название типа
     */
    function fillIds(list, prefixOf, nameOf) {
      var used = {};
      var i, it;
      for (i = 0; i < list.length; i++) {
        it = list[i];
        if (it && it.id) used[it.id] = true;
      }
      for (i = 0; i < list.length; i++) {
        it = list[i];
        if (!it) continue;
        if (!it.id) {
          var p = prefixOf(it);
          var n = i + 1;
          while (used[p + n]) n++;
          it.id = p + n;
          used[it.id] = true;
        }
        if (!it.title) it.title = nameOf(it) + ' ' + (i + 1);
      }
    }

    /**
     * Конфигурация с присвоенными id и названиями. Исходный объект не
     * меняется. Повторный вызов ничего не меняет.
     * @param {Array} zones секция zones
     * @returns {Array}
     */
    function normalize(zones) {
      var res = [];
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        if (!z || typeof z !== 'object') {
          res.push(z);
          continue;
        }
        var zc = shallowCopy(z);
        var devs = [];
        var src = z.devices || [];
        for (var j = 0; j < src.length; j++) {
          devs.push(src[j] && typeof src[j] === 'object' ? shallowCopy(src[j]) : src[j]);
        }
        fillIds(
          devs,
          function (d) {
            var t = DEVICE_TYPES[d.type || 'convector'];
            return t ? t.prefix : 'dev';
          },
          function (d) {
            var t = DEVICE_TYPES[d.type || 'convector'];
            return t ? t.name : 'Устройство';
          }
        );
        zc.devices = devs;
        res.push(zc);
      }
      fillIds(
        res,
        function () {
          return 'climate_room';
        },
        function () {
          return 'Помещение';
        }
      );
      return res;
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
      // Уставка — целые градусы: на карточке бегунок (range), а range по
      // конвенциям Wiren Board только целочисленный
      this.spMin = Math.round(U.def(c.setpointMin, 16));
      this.spMax = Math.max(this.spMin, Math.round(U.def(c.setpointMax, 40)));
      this.spDefault = U.clamp(Math.round(U.def(cfg.defaultSetpoint, 22)), this.spMin, this.spMax);
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
      // Уставка — бегунок с шагом 1 °C (пользователь на стенде: «уставку
      // бегунком, 16–40, пусть будут целые числа»)
      add(
        'setpoint',
        {
          title: { en: 'Setpoint', ru: 'Уставка' },
          type: 'range',
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
      this._dropStaleControls(cells);
    };

    /** id, безопасный для подписки MQTT: «+» и «#» сделали бы его маской. */
    var SAFE_ID = /^[0-9A-Za-z_-]+$/;

    /**
     * Убрать с карточки контролы, которых нет в конфигурации: прибор удалён
     * или у него сменился id. wb-rules не стирает retained-топики контролов,
     * которые больше не объявлены, и карточка показывала «Конвектор 1: клапан»
     * удалённого прибора с последним значением (контроллер, 2026-10-02).
     * Список топиков устройства даёт mosquitto_sub (-F %t — только топики),
     * лишние стираются пустым retained-сообщением. Чужие устройства не
     * затрагиваются: маска — только /devices/<id помещения>/controls/#.
     */
    Zone.prototype._dropStaleControls = function (cells) {
      if (typeof runShellCommand !== 'function' || typeof publish !== 'function') return;
      if (!SAFE_ID.test(this.id)) return;
      var self = this;
      var base = '/devices/' + this.id + '/controls/';
      // По -W mosquitto_sub выходит с ошибкой всегда — код возврата не смотрим
      runShellCommand("mosquitto_sub -t '" + base + "#' --retained-only -F %t -W 2", {
        captureOutput: true,
        exitCallback: function (code, out) {
          // Зону пересоздали, пока ждали брокер, — у неё свой набор контролов
          if (module.static.zones[self.id] !== self) return;
          var lines = String(out || '').split('\n');
          var gone = [];
          for (var i = 0; i < lines.length; i++) {
            var topic = lines[i].replace(/^\s+|\s+$/g, '');
            if (topic.indexOf(base) !== 0) continue;
            var name = topic.substring(base.length).split('/')[0];
            if (!name || Object.prototype.hasOwnProperty.call(cells, name)) continue;
            try {
              publish(topic, '', 1, true);
            } catch (e) {
              log.error('wbclim: {}: не удалось стереть {}: {}', self.id, topic, e);
              continue;
            }
            if (gone.indexOf(name) < 0) gone.push(name);
          }
          if (gone.length) log.info('wbclim: {}: с карточки убраны контролы удалённых приборов: {}', self.id, gone.join(', '));
        }
      });
    };

    Zone.prototype._c = function (name) {
      return this.id + '/' + name;
    };

    /** Функция чтения контролов исполнителя: имя без префикса. */
    Zone.prototype._getter = function (prefix) {
      var self = this;
      return function (name) {
        return dev[self._c(prefix + name)];
      };
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
      // Правка настроек исполнителей на карточке («пол не ниже») — тоже сразу
      var list = this.cfg.devices || [];
      for (var j = 0; j < list.length; j++) {
        var d = list[j] || {};
        var t = DEVICE_TYPES[d.type || 'convector'];
        if (!t) continue;
        var ctls = t.controlsOf(d, deviceTitle(d, j));
        for (var k = 0; k < ctls.length; k++) {
          if (ctls[k].writable) watch.push(this._c(deviceId(d, j) + '_' + ctls[k].name));
        }
      }
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

    /**
     * Уставка с контрола: целые градусы в пределах. Неверный ввод и дробная
     * уставка, сохранённая версией до бегунка (21,5), исправляются на карточке.
     */
    Zone.prototype._setpoint = function () {
      var raw = U.toNum(dev[this._c('setpoint')]);
      var sp = U.isNum(raw) ? Math.round(U.clamp(raw, this.spMin, this.spMax)) : this.spDefault;
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
      for (var i = 0; i < this.devices.length; i++) {
        var d = this.devices[i];
        // auto — регулирование по уставке: конвектор может брать скорость
        // по разнице температур (в ручном режиме, на защитах и при отказе
        // датчиков — только по потребности)
        var auto = state === 'idle' || state === 'ready' || state === 'heating';
        var info = { setpoint: sp, temperature: t, auto: auto, get: this._getter(d.id + '_') };
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
      zones = normalize(zones);
      var res = {};
      var all = [];
      var seenZones = {};
      for (var i = 0; i < zones.length; i++) {
        var z = zones[i];
        if (!z || !z.id) continue;
        var p = (res[z.id] = res[z.id] || []);
        if (seenZones[z.id]) p.push('id «' + z.id + '» повторяется — очистите поле id, номер присвоится сам');
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
          if (ids[did]) p.push(title + ': id «' + did + '» повторяется — очистите поле id, номер присвоится сам');
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
      cfg = normalize([cfg])[0];
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
    exports.normalize = normalize;
    exports.MODE_AUTO = MODE_AUTO;
    exports.MODE_MANUAL = MODE_MANUAL;

  };

  /* ---------------- точка входа ---------------- */

  var ZONE = require('wbclim-zone');
  // Пустые id и названия помещений и приборов — присвоить по порядку
  var zones = ZONE.normalize((CONFIG && CONFIG.zones) || []);

  // Зоны проверяются разом до запуска любой из них: одно реле в двух
  // зонах видно только на полном списке.
  var problems = ZONE.checkZones(zones);
  var ids = [];

  for (var i = 0; i < zones.length; i++) {
    var z = zones[i];
    if (!z || !z.id) {
      log.error('wbclim: зона #{} без поля "id" — пропущена', i);
      continue;
    }
    ids.push(z.id);
    try {
      ZONE.create(z, problems[z.id]);
    } catch (e) {
      log.error('wbclim: не удалось создать зону "{}": {}', z.id, e);
    }
  }
  ZONE.prune(ids);

  log.info('wbclim: зон в работе: {}', ids.length);
})();
