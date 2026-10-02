/**
 * make-schema.js — генератор формы настроек wb-mqtt-confed.
 *
 * Схема — больше тысячи строк JSON с переводами на две локали; поля
 * исполнителей повторяются (топики, числа, роли). Здесь они описаны
 * один раз, а JSON собирается. Источник правды — этот файл:
 * usr/share/wb-mqtt-confed/schemas/wb-climate.schema.json руками не править.
 *
 * Запуск: node tools/make-schema.js            — пересобрать
 *         node tools/make-schema.js --check    — сверить (для тестов и CI)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'usr', 'share', 'wb-mqtt-confed', 'schemas', 'wb-climate.schema.json');

const T = { en: {}, ru: {} };
function tr(key, en, ru) {
  T.en[key] = en;
  T.ru[key] = ru;
  return key;
}

function topic(key, en, ru, descEn, descRu, order, cols) {
  const f = {
    type: 'string',
    title: tr(key + 'Title', en, ru),
    pattern: '^$|^[^/+#]+/[^/+#]+$',
    minLength: 0,
    _format: 'wb-autocomplete',
    default: '',
    propertyOrder: order,
    options: {
      patternmessage: 'errMqttTopic',
      inputAttributes: { placeholder: 'phMqttTopic' },
      wb: { data: 'devices' },
      grid_columns: cols || 12
    }
  };
  if (descEn) f.description = tr(key + 'Description', descEn, descRu);
  return f;
}

function topicArray(key, en, ru, descEn, descRu, order, minItems) {
  const a = {
    type: 'array',
    title: tr(key + 'Title', en, ru),
    _format: 'table',
    propertyOrder: order,
    items: {
      type: 'object',
      title: 'topicRowTitle',
      properties: {
        control: {
          type: 'string',
          title: 'topicColTitle',
          pattern: '^$|^[^/+#]+/[^/+#]+$',
          minLength: 0,
          _format: 'wb-autocomplete',
          default: '',
          options: {
            patternmessage: 'errMqttTopic',
            inputAttributes: { placeholder: 'phMqttTopic' },
            wb: { data: 'devices' }
          }
        }
      },
      required: ['control']
    },
    options: { disable_array_reorder: true, disable_collapse: true, grid_columns: 12 }
  };
  if (descEn) a.description = tr(key + 'Description', descEn, descRu);
  if (minItems) a.minItems = minItems;
  return a;
}

function num(key, en, ru, descEn, descRu, min, max, def, order, cols, integer) {
  const f = {
    type: integer ? 'integer' : 'number',
    title: tr(key + 'Title', en, ru),
    minimum: min,
    maximum: max,
    default: def,
    propertyOrder: order,
    options: { grid_columns: cols || 4 }
  };
  if (descEn) f.description = tr(key + 'Description', descEn, descRu);
  return f;
}

function bool(key, en, ru, descEn, descRu, def, order, cols) {
  const f = {
    type: 'boolean',
    title: tr(key + 'Title', en, ru),
    default: def,
    _format: 'checkbox',
    propertyOrder: order,
    options: { grid_columns: cols || 4 }
  };
  if (descEn) f.description = tr(key + 'Description', descEn, descRu);
  return f;
}

function hiddenType(value) {
  return { type: 'string', enum: [value], default: value, options: { hidden: true } };
}

function group(key, en, ru, descEn, descRu, props, order, required) {
  const g = {
    type: 'object',
    title: tr(key + 'Title', en, ru),
    _format: 'grid',
    propertyOrder: order,
    options: { disable_edit_json: true, disable_properties: true, disable_collapse: false },
    properties: props
  };
  if (descEn) g.description = tr(key + 'Description', descEn, descRu);
  if (required) g.required = required;
  return g;
}

tr('errMqttTopic', 'Must match the format <device>/<control>', 'Формат: <устройство>/<контрол>');
tr('errId', 'Latin letters, digits and underscore only', 'Только латиница, цифры и _');
tr('phMqttTopic', 'Device/Control', 'Устройство/Контрол');
tr('topicRowTitle', 'Control', 'Контрол');
tr('topicColTitle', 'Device/Control', 'Устройство/Контрол');
tr('phAuto', 'auto', 'авто');
// Названия типов приборов для заголовков ({{translate self.type}})
tr('convector', 'Convector', 'Конвектор');
tr('floor', 'Underfloor heating', 'Тёплый пол');

/* ---------------- вентилятор ---------------- */
const fanStart = () => num('fanStart', 'Fan starts at demand, %', 'Вентилятор включается с потребности, %',
  'Below this the convector heats by natural convection only', 'Ниже — греет только естественной конвекцией', 0, 95, 20, 20, 4);
const fanHyst = () => num('fanHyst', 'Speed-down hysteresis, %', 'Гистерезис снижения скорости, %',
  'Fewer relay clicks near a step threshold', 'Меньше щелчков реле у порога ступени', 0, 30, 10, 21, 4);
const fanStep = () => num('fanStep', 'Min time between speed changes, s', 'Выдержка между сменами скорости, с',
  null, null, 0, 600, 60, 22, 4, true);
const fanDelay = () => num('fanDelay', 'Fan delay after valve opens, s', 'Задержка вентилятора после открытия клапана, с',
  'No cold draft: wait until the heat exchanger warms up', 'Защита от холодного дутья: ждать прогрева теплообменника', 0, 900, 180, 23, 4, true);
const fanMinWater = () => num('fanMinWater', 'Min water temperature for fan, °C', 'Мин. температура воды для вентилятора, °C',
  'Used instead of the delay when a water sensor is set', 'Вместо задержки, если задан датчик воды', 15, 60, 30, 24, 4);
const fanMin = () => num('fanMin', 'Min running speed, %', 'Минимальная скорость на ходу, %',
  'EC motors do not start below ~20 %', 'ЕС-двигатели не стартуют ниже ~20 %', 0, 100, 20, 25, 4);
const fanMax = () => num('fanMax', 'Max speed, %', 'Максимальная скорость, %', null, null, 10, 100, 100, 26, 4);
const fanEnable = () => topic('fanEnable', 'Fan power relay', 'Реле питания вентилятора',
  'Optional: switched on while the fan runs', 'Необязательно: включено, пока вентилятор работает', 15, 6);

const defs = {};
defs.fanNone = {
  type: 'object',
  title: tr('fanNoneTitle', 'No fan (passive convector)', 'Нет вентилятора (пассивный конвектор)'),
  description: tr('fanNoneDescription', 'Controlled by the thermal actuator only, like underfloor heating', 'Только термоголовка, как тёплый пол'),
  options: { disable_collapse: true, disable_edit_json: true },
  properties: { type: hiddenType('none') },
  required: ['type']
};
/**
 * Реле скоростей: скорость — номер строки, а в таблице строки безымянные
 * («как понять, где какая скорость?» — пользователь на стенде). Обычный
 * список вместо таблицы: json-editor подписывает элемент заголовком
 * «<title элемента> <номер>» — «Скорость 1», «Скорость 2», «Скорость 3»
 * (так же было «Прибор 1» до headerTemplate). Формат конфига прежний.
 */
function speedArray() {
  const a = topicArray('fanSpeeds', 'Speed relays (slow → fast) *', 'Реле скоростей (от медленной к быстрой) *',
    'Speed 1 is the slowest. The relay number does not matter, only the order', 'Скорость 1 — самая медленная. Номер реле значения не имеет — только порядок', 1, 1);
  delete a._format;
  a.maxItems = 3;
  a.items.title = tr('fanSpeedRowTitle', 'Speed', 'Скорость');
  a.items.options = { disable_collapse: true, disable_edit_json: true, disable_properties: true };
  return a;
}

defs.fanRelays = {
  type: 'object',
  title: tr('fanRelaysTitle', 'Relays, 1–3 speeds', 'Реле, 1–3 скорости'),
  description: tr('fanRelaysDescription', 'One relay per speed, slow to fast', 'По реле на скорость, от медленной к быстрой'),
  _format: 'grid',
  options: { disable_collapse: true, disable_edit_json: true },
  properties: {
    type: hiddenType('relays'),
    speeds: speedArray(),
    relayMode: {
      type: 'string',
      title: tr('fanRelayModeTitle', 'Relay mode', 'Режим реле'),
      enum: ['exclusive', 'cumulative'],
      default: 'exclusive',
      propertyOrder: 2,
      options: {
        enum_titles: [
          tr('fanRelayModeExclusive', 'One relay per speed (motor taps)', 'Одно реле на скорость (отводы обмотки)'),
          tr('fanRelayModeCumulative', 'Speed N = relays 1..N', 'Скорость N = реле 1..N')
        ],
        grid_columns: 6
      }
    },
    interlock: num('fanInterlock', 'Pause on speed change, ms', 'Пауза при смене скорости, мс',
      'Two motor taps must never be on together', 'Два отвода обмотки не должны быть включены одновременно', 0, 5000, 500, 3, 6, true),
    speedBy: {
      type: 'string',
      title: tr('fanSpeedByTitle', 'Speed by', 'Скорость выбирается'),
      description: tr('fanSpeedByDescription',
        'By difference: setpoint − temperature 0…step — speed 1, step…2·step — speed 2, further — speed 3; the valve is open while the room is colder than the setpoint',
        'По разнице: уставка − температура 0…шаг — скорость 1, шаг…2 шага — скорость 2, дальше — скорость 3; клапан открыт, пока в комнате холоднее уставки'),
      enum: ['delta', 'demand'],
      default: 'delta',
      propertyOrder: 4,
      options: {
        enum_titles: [
          tr('fanSpeedByDelta', 'By temperature difference', 'По разнице температур'),
          tr('fanSpeedByDemand', 'By room heat demand (%)', 'По потребности помещения (%)')
        ],
        grid_columns: 6
      }
    },
    deltaStep: num('fanDeltaStep', 'Speed step, °C', 'Шаг скорости, °C',
      'By difference: 2 — speed 1 below 2 °C, speed 2 from 2 °C, speed 3 from 4 °C', 'По разнице: 2 — скорость 1 до 2 °C, скорость 2 с 2 °C, скорость 3 с 4 °C', 0.5, 10, 2, 5, 3),
    deltaHyst: num('fanDeltaHyst', 'Difference hysteresis, °C', 'Гистерезис по разнице, °C',
      'Speed drops this much below its threshold; the fan stops when the room is this much above the setpoint', 'Скорость снижается на столько ниже своего порога; вентилятор останавливается, когда в комнате на столько теплее уставки', 0, 1, 0.3, 6, 3),
    enable: fanEnable(),
    start: Object.assign(fanStart(), { description: tr('fanStartByDemandDescription', 'By demand only. Below this — natural convection', 'Только «по потребности». Ниже — греет естественной конвекцией') }),
    hyst: Object.assign(fanHyst(), { description: tr('fanHystByDemandDescription', 'By demand only. Fewer relay clicks near a step threshold', 'Только «по потребности». Меньше щелчков реле у порога ступени') }),
    minStepTime: fanStep(),
    delay: fanDelay(),
    minWater: fanMinWater()
  },
  required: ['type', 'speeds']
};
defs.fanAnalog = {
  type: 'object',
  title: tr('fanAnalogTitle', 'Analog 0-10 V', 'Аналоговый 0-10 В'),
  description: tr('fanAnalogDescription', 'EC fan, WB-MAO4 output in mV', 'ЕС-вентилятор, выход WB-MAO4 в мВ'),
  _format: 'grid',
  options: { disable_collapse: true, disable_edit_json: true },
  properties: {
    type: hiddenType('analog'),
    out: topic('fanOut', 'Analog output *', 'Аналоговый выход *', null, null, 1, 6),
    valueMin: num('fanValueMin', 'Value at 0 %', 'Значение при 0 %', 'mV; 2000 for 2-10 V fans', 'мВ; 2000 для вентиляторов 2-10 В', 0, 10000, 0, 2, 3),
    valueMax: num('fanValueMax', 'Value at 100 %', 'Значение при 100 %', null, null, 1, 10000, 10000, 3, 3),
    enable: fanEnable(),
    start: fanStart(),
    min: fanMin(),
    max: fanMax(),
    hyst: fanHyst(),
    delay: fanDelay(),
    minWater: fanMinWater()
  },
  required: ['type', 'out']
};
defs.fanModbus = {
  type: 'object',
  title: tr('fanModbusTitle', 'Modbus (convector controller)', 'Modbus (контроллер конвектора)'),
  description: tr('fanModbusDescription', 'Speed is written to a register exposed by the wb-mqtt-serial template', 'Скорость пишется в регистр конвектора через шаблон wb-mqtt-serial'),
  _format: 'grid',
  options: { disable_collapse: true, disable_edit_json: true },
  properties: {
    type: hiddenType('modbus'),
    out: topic('fanModbusOut', 'Speed register *', 'Регистр скорости *', null, null, 1, 6),
    steps: num('fanSteps', 'Speed steps (0 = smooth)', 'Ступеней скорости (0 — плавно)',
      'Steps: writes 0..N. Smooth: value range below', 'Ступени: пишется 0..N. Плавно: шкала ниже', 0, 10, 3, 2, 6, true),
    values: {
      type: 'array',
      title: tr('fanValuesTitle', 'Step values', 'Значения ступеней'),
      description: tr('fanValuesDescription', 'Optional: register value for steps 1..N, e.g. 30, 60, 100. Overrides the step count', 'Необязательно: значение регистра для ступеней 1..N, например 30, 60, 100. Число ступеней берётся отсюда'),
      _format: 'table',
      propertyOrder: 3,
      items: { type: 'number', title: tr('fanValueColTitle', 'Value', 'Значение') },
      options: { disable_array_reorder: true, disable_collapse: true, grid_columns: 12 }
    },
    valueMin: num('fanModbusValueMin', 'Value at 0 % (smooth)', 'Значение при 0 % (плавно)', null, null, 0, 65535, 0, 4, 3),
    valueMax: num('fanModbusValueMax', 'Value at 100 % (smooth)', 'Значение при 100 % (плавно)', null, null, 1, 65535, 100, 5, 3),
    minChange: num('fanMinChange', 'Smooth: min change to write, %', 'Плавно: не писать изменения меньше, %',
      'Controller boards may store every write in non-volatile memory', 'Плата конвектора может сохранять каждую запись в энергонезависимую память', 0, 50, 5, 6, 6),
    enable: fanEnable(),
    start: fanStart(),
    min: fanMin(),
    max: fanMax(),
    hyst: fanHyst(),
    minStepTime: fanStep(),
    delay: fanDelay(),
    minWater: fanMinWater()
  },
  required: ['type', 'out']
};

/* ---------------- общие поля исполнителей ---------------- */
// id и название по умолчанию пустые: номер присваивает код («вслед за
// существующим»). Редактор формы не умеет нумеровать элементы массива,
// и с умолчанием conv1 каждый новый прибор получал бы тот же id.
function devId(desc) {
  return {
    type: 'string',
    title: tr('devIdTitle', 'id', 'id'),
    description: desc,
    pattern: '^$|^[a-z0-9_]+$',
    minLength: 0,
    maxLength: 20,
    default: '',
    propertyOrder: 1,
    options: { patternmessage: 'errId', inputAttributes: { placeholder: 'phAuto' }, grid_columns: 4 }
  };
}
function devName() {
  return {
    type: 'string',
    title: tr('devNameTitle', 'Name', 'Название'),
    description: tr('devNameDescription', 'Empty — type and number in the list, as in the header: «Convector 2»', 'Пусто — тип и номер в списке, как в заголовке: «Конвектор 2»'),
    default: '',
    propertyOrder: 2,
    options: { inputAttributes: { placeholder: 'phAuto' }, grid_columns: 8 }
  };
}
// Роль в нагреве — выпадающий список, а не «пустые» числа: редактор формы
// сохранил бы в пустые числовые поля нули, а доля 0…0 — ошибка
function roleFields(props) {
  props.role = {
    type: 'string',
    title: tr('roleTitle', 'Role in heating', 'Участие в нагреве'),
    description: tr('roleDescription', 'Auto: with both a floor and a convector in the room the floor is the base and the convector the boost', 'Авто: если в помещении есть и пол, и конвектор, — пол основной, конвектор догрев'),
    enum: ['auto', 'base', 'boost', 'all', 'custom'],
    default: 'auto',
    propertyOrder: 3,
    options: {
      enum_titles: [
        tr('roleAuto', 'Auto', 'Авто'),
        tr('roleBase', 'Base (demand 0–70 %)', 'Основной (потребность 0–70 %)'),
        tr('roleBoost', 'Boost (demand 50–100 %)', 'Догрев (потребность 50–100 %)'),
        tr('roleAll', 'Always (0–100 %)', 'Всегда (0–100 %)'),
        tr('roleCustom', 'Custom range', 'Свои границы')
      ],
      grid_columns: 4
    }
  };
  props.demandFrom = num('demandFrom', 'Demand from, %', 'Потребность от, %', null, null, 0, 99, 0, 4, 2, true);
  props.demandFrom.options.dependencies = { role: 'custom' };
  props.demandTo = num('demandTo', 'Demand to, %', 'Потребность до, %', null, null, 1, 100, 100, 5, 2, true);
  props.demandTo.options.dependencies = { role: 'custom' };
  return props;
}
function valveGroup(d, withMode) {
  const p = {
    topics: topicArray('valveTopics', 'Relays *', 'Реле *', 'All relays of the group switch together', 'Все реле группы переключаются вместе', 1, 1),
    normallyOpen: bool('valveNo', 'Normally open (NO)', 'Нормально открытые (NO)',
      'Default NC: closed when de-energized', 'По умолчанию NC: обесточена — закрыта', false, 2, 4),
    minOn: num('valveMinOn', 'Min open time, s', 'Мин. время открытой, с',
      'Thermal actuators take 2–4 min to open', 'Термоголовке нужно 2–4 мин, чтобы открыться', 0, 1800, d.minOn, 4, 4, true),
    minOff: num('valveMinOff', 'Min closed time, s', 'Мин. время закрытой, с', null, null, 0, 1800, d.minOff, 5, 4, true),
    openTime: num('valveOpenTime', 'Full opening time, s', 'Время полного открытия, с',
      'From the datasheet, typically 180', 'Из паспорта, обычно 180', 30, 600, d.openTime, 6, 4, true),
    cycle: num('valveCycle', 'PWM period, s', 'Период ШИМ, с', null, null, 300, 3600, d.cycle, 7, 4, true)
  };
  if (withMode) {
    p.mode = {
      type: 'string',
      title: tr('valveModeTitle', 'Mode', 'Режим'),
      enum: ['onoff', 'pwm'],
      default: 'onoff',
      propertyOrder: 3,
      options: {
        enum_titles: [
          tr('valveModeOnoff', 'On/off by demand', 'Открыт/закрыт по потребности'),
          tr('valveModePwm', 'PWM', 'ШИМ')
        ],
        grid_columns: 8
      }
    };
    // период ШИМ виден только в режиме ШИМ (как в wb-scenarios)
    p.cycle.options.dependencies = { mode: 'pwm' };
  }
  return p;
}

/* ---------------- конвектор ---------------- */
defs.convector = {
  type: 'object',
  title: tr('convTitle', 'Convector', 'Конвектор'),
  headerTemplate: '{{ self.title }}',
  _format: 'grid',
  options: { disable_edit_json: true, disable_collapse: false },
  properties: {
    type: hiddenType('convector'),
    id: devId(tr('convIdDescription', 'Prefix of the room card controls (conv2_valve). Empty — by the number in the list: conv2 for the second device', 'Префикс контролов на карточке помещения (conv2_valve). Пусто — по номеру в списке: у второго прибора conv2')),
    title: devName(),
    valve: group('valve', 'Thermal actuator (valve)', 'Термоголовка (клапан)', null, null,
      valveGroup({ minOn: 120, minOff: 120, openTime: 180, cycle: 900 }, true), 10, ['topics']),
    fan: {
      title: tr('fanTitle', 'Fan', 'Вентилятор'),
      description: tr('fanDescription', 'Pick the fan control type', 'Выберите способ управления вентилятором'),
      propertyOrder: 11,
      oneOf: [
        { $ref: '#/definitions/fanRelays' },
        { $ref: '#/definitions/fanAnalog' },
        { $ref: '#/definitions/fanModbus' },
        { $ref: '#/definitions/fanNone' }
      ],
      options: { keep_oneof_values: false, disable_collapse: true, disable_edit_json: true }
    },
    waterSensor: topic('convWater', 'Water / heat exchanger sensor', 'Датчик воды / теплообменника',
      'Optional: fan waits for hot water by this sensor instead of the delay', 'Необязательно: вентилятор ждёт горячую воду по нему, а не по таймеру', 12)
  },
  required: ['type', 'id', 'valve', 'fan']
};
roleFields(defs.convector.properties);

/* ---------------- тёплый пол ---------------- */
defs.floor = {
  type: 'object',
  title: tr('floorTitle', 'Underfloor heating', 'Тёплый пол'),
  headerTemplate: '{{ self.title }}',
  _format: 'grid',
  options: { disable_edit_json: true, disable_collapse: false },
  properties: {
    type: hiddenType('floor'),
    id: devId(tr('floorIdDescription', 'Prefix of the room card controls (floor1_valve). Empty — by the number in the list: floor1 for the first device', 'Префикс контролов на карточке помещения (floor1_valve). Пусто — по номеру в списке: у первого прибора floor1')),
    title: devName(),
    valve: group('floorValve', 'Loop thermal actuators', 'Термоголовки петель', null, null,
      valveGroup({ minOn: 180, minOff: 180, openTime: 180, cycle: 1200 }, false), 10, ['topics']),
    floorSensors: topicArray('floorSensors', 'Floor sensors', 'Датчики пола',
      'In the screed, one or more; the average of healthy ones is used. Without them the loops follow the room demand by PWM',
      'В стяжке, один или несколько; берётся среднее по исправным. Без них петли работают ШИМ по потребности помещения', 11),
    minFloor: num('minFloor', 'Floor minimum, °C (0 = room setpoint)', 'Пол не ниже, °C (0 — по уставке помещения)',
      'Held always: also when the room is off or a window is open. Initial value — then on the room card',
      'Держится всегда: и при выключенном помещении, и при открытом окне. Начальное значение — дальше на карточке помещения', 0, 35, 0, 12, 4),
    maxFloor: num('maxFloor', 'Floor maximum, °C', 'Пол не выше, °C',
      'EN 1264: 29 living rooms, 33 bathrooms. SP 60.13330: 26 for permanent stay', 'EN 1264: 29 жилые, 33 санузлы. СП 60.13330: 26 для постоянного пребывания', 20, 40, 29, 13, 4),
    floorHyst: num('floorHyst', 'Floor hysteresis, K', 'Гистерезис пола, К', null, null, 0.2, 3, 0.5, 14, 4)
  },
  required: ['type', 'id', 'valve']
};
roleFields(defs.floor.properties);

/* ---------------- зона ---------------- */
// Шаблоны заголовков — dumbtemplate из веб-интерфейса Wiren Board
// (homeui, json-editor/extensions/dumbtemplate.js): {{if}}…{{else}}…{{endif}},
// {{translate VAR}} — перевод из translations этой схемы. Без названия
// заголовок показывает то же, что присвоит код (normalize в wbclim-zone.js).
defs.zone = {
  type: 'object',
  title: tr('zoneTitle', 'Room', 'Помещение'),
  headerTemplate: '{{if self.title == ""}}{{title}}{{else}}{{self.title}}{{endif}}',
  _format: 'grid',
  options: { disable_edit_json: true },
  properties: {
    id: {
      type: 'string',
      title: tr('zoneIdTitle', 'MQTT id', 'MQTT id'),
      description: tr('zoneIdDescription', 'Virtual device id, e.g. climate_living. Empty — by the number in the list: climate_room2. Set it explicitly if scenarios or Sprut.hub use the room', 'id виртуального устройства, например climate_living. Пусто — по номеру в списке: climate_room2. Если на помещение завязаны сценарии или Sprut.hub — задайте вручную'),
      pattern: '^$|^[0-9a-zA-Z_]+$',
      minLength: 0,
      maxLength: 40,
      default: '',
      propertyOrder: 1,
      options: { patternmessage: 'errId', inputAttributes: { placeholder: 'phAuto' }, grid_columns: 4 }
    },
    title: {
      type: 'string',
      title: tr('zoneNameTitle', 'Name', 'Название'),
      description: tr('zoneNameDescription', 'Empty — «Room 2» by the number in the list, as in the header', 'Пусто — «Помещение 2» по номеру в списке, как в заголовке'),
      default: '',
      propertyOrder: 2,
      options: { inputAttributes: { placeholder: 'phAuto' }, grid_columns: 4 }
    },
    defaultSetpoint: num('zoneSetpoint', 'Default setpoint, °C', 'Уставка по умолчанию, °C',
      'Then set on the room card (slider, whole degrees)', 'Дальше задаётся на карточке помещения (бегунок, целые градусы)', 5, 40, 22, 3, 2, true),
    defaultEnabled: bool('zoneEnabled', 'Enabled by default', 'Включено по умолчанию', null, null, true, 4, 2),
    sensors: group('sensors', 'Sensors', 'Датчики', 'Pick controls from the list of MQTT topics', 'Выберите контролы из списка MQTT-топиков', {
      temperature: topicArray('senTemp', 'Temperature *', 'Температура *',
        'One or more; the average of healthy ones is used', 'Один или несколько; берётся среднее по исправным', 1, 1),
      humidity: topicArray('senHum', 'Humidity', 'Влажность', 'Shown on the card for now', 'Пока только показывается на карточке', 2),
      tau: num('senTau', 'Filter time constant, s', 'Постоянная фильтра, с', null, null, 0, 600, 30, 3, 4)
    }, 10, ['temperature']),
    window: group('window', 'Window', 'Окно', 'Heating pauses while a window is open', 'Пока окно открыто, отопление на паузе', {
      topics: topicArray('winTopics', 'Window contacts', 'Датчики окна', null, null, 1),
      invert: bool('winInvert', 'Open = false', 'Открыто = false', 'For NC reed switches', 'Для нормально замкнутых герконов', false, 2, 4),
      delay: num('winDelay', 'Delay, s', 'Задержка, с', 'Short airing does not stop heating', 'Короткое проветривание не останавливает нагрев', 0, 600, 30, 3, 4, true)
    }, 20),
    control: group('control', 'Control', 'Регулирование', 'Fine-tune on the room card', 'Тонкая настройка — на карточке помещения', {
      band: num('ctlBand', 'Proportional band, K', 'Зона пропорциональности, К',
        'Lag behind setpoint for 100 % demand: valve open, fan at full speed', 'Отставание от уставки, при котором потребность 100 %: клапан открыт, вентилятор на максимуме', 0.5, 10, 1.5, 1, 4),
      ti: num('ctlTi', 'Integral time, min', 'Время интегрирования, мин',
        'Removes steady undershoot in cold weather. 0 = P only', 'Снимает недобор в мороз. 0 — чистый П', 0, 240, 30, 2, 4, true),
      period: num('ctlPeriod', 'Control period, s', 'Такт, с', null, null, 2, 60, 10, 3, 4, true),
      setpointMin: num('ctlSpMin', 'Setpoint min, °C', 'Уставка не ниже, °C', null, null, 5, 30, 16, 4, 4, true),
      setpointMax: num('ctlSpMax', 'Setpoint max, °C', 'Уставка не выше, °C', null, null, 15, 40, 40, 5, 4, true)
    }, 30),
    safety: group('safety', 'Protection', 'Защиты', null, null, {
      frostProtect: bool('safFrost', 'Frost protection', 'Защита от замерзания', 'Works even when the room is off', 'Работает и в выключенном помещении', true, 1, 4),
      frostTemp: num('safFrostTemp', 'Frost temperature, °C', 'Температура защиты, °C', null, null, 3, 15, 7, 2, 4),
      failSafeDemand: num('safFailSafe', 'Demand on sensor failure, %', 'Потребность при отказе датчиков, %',
        '0 = do not heat, alarm on the card', '0 — не греть, авария на карточке', 0, 100, 0, 3, 4, true)
    }, 40),
    devices: {
      type: 'array',
      title: tr('devicesTitle', 'Heating devices', 'Отопительные приборы'),
      description: tr('devicesDescription', 'Convectors and underfloor heating: all follow the heat demand of the room', 'Конвекторы и тёплый пол: все работают от общей потребности помещения в тепле'),
      propertyOrder: 50,
      items: {
        title: tr('deviceTitle', 'Device', 'Прибор'),
        headerTemplate: '{{if self.title == ""}}{{translate self.type}} {{i1}}{{else}}{{self.title}}{{endif}}',
        oneOf: [{ $ref: '#/definitions/convector' }, { $ref: '#/definitions/floor' }],
        options: { keep_oneof_values: false, disable_edit_json: true }
      },
      options: { disable_array_reorder: true, array_controls_top: true }
    },
    debug: bool('zoneDebug', 'Debug logging', 'Отладочный журнал', null, null, false, 60, 4)
  },
  required: ['id', 'sensors']
};

const schema = {
  $schema: 'http://json-schema.org/draft-04/schema#',
  type: 'object',
  title: tr('climateTitle', 'Climate control', 'Климат-контроль'),
  description: tr('climateDescription',
    'Rooms: setpoint, heat demand, convectors and underfloor heating',
    'Помещения: уставка, потребность в тепле, конвекторы и тёплый пол'),
  configFile: { path: '/etc/wb-climate.conf', service: 'wb-rules' },
  definitions: defs,
  properties: {
    zones: {
      type: 'array',
      title: tr('zonesTitle', 'Rooms', 'Помещения'),
      description: tr('zonesDescription', 'One entry per room. Each creates its own virtual device.', 'По записи на помещение. Каждое создаёт своё виртуальное устройство.'),
      propertyOrder: 1,
      items: { $ref: '#/definitions/zone' },
      options: { disable_array_reorder: true, array_controls_top: true, wb: { disable_panel: false } }
    }
  },
  required: ['zones'],
  translations: T
};

const text = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.log('схема устарела — выполните node tools/make-schema.js');
    process.exit(1);
  }
  console.log('схема соответствует генератору');
} else {
  fs.writeFileSync(OUT, text, 'utf8');
  console.log('Собрано: ' + path.relative(path.join(__dirname, '..'), OUT) + ', ключей перевода: ' + Object.keys(T.ru).length);
}
