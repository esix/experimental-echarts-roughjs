import './rough/index';
import ReactECharts from 'echarts-for-react';

const OPTS = { renderer: 'rough' };

const FONT = { fontFamily: 'Caveat, cursive', fontSize: 20 };

// ── Weekly bar chart ──────────────────────────────────────────────────────────
const barOption = {
  textStyle: FONT,
  title: { text: 'Weekly Sales', left: 'center', textStyle: FONT },
  tooltip: { trigger: 'axis', textStyle: FONT },
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], axisLabel: { textStyle: FONT } },
  yAxis: { type: 'value', axisLabel: { textStyle: FONT } },
  series: [
    {
      name: 'Sales',
      type: 'bar',
      data: [120, 200, 150, 80, 70, 110, 130],
      itemStyle: { color: '#5470c6', borderColor: '#1a3a9c', borderWidth: 2 },
      label: { show: false },
    },
  ],
};

// ── Grouped bar chart ─────────────────────────────────────────────────────────
const groupedBarOption = {
  textStyle: FONT,
  title: { text: 'Q1 Revenue by Region', left: 'center', textStyle: FONT },
  tooltip: { trigger: 'axis', textStyle: FONT },
  legend: { top: 30, textStyle: FONT },
  xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'], axisLabel: { textStyle: FONT } },
  yAxis: { type: 'value', axisLabel: { textStyle: FONT } },
  series: [
    {
      name: 'North',
      type: 'bar',
      data: [320, 280, 410],
      itemStyle: { color: '#91cc75', borderColor: '#3a7d2c', borderWidth: 2 },
    },
    {
      name: 'South',
      type: 'bar',
      data: [240, 310, 190],
      itemStyle: { color: '#fac858', borderColor: '#a87200', borderWidth: 2 },
    },
    {
      name: 'East',
      type: 'bar',
      data: [180, 230, 275],
      itemStyle: { color: '#ee6666', borderColor: '#9b1c1c', borderWidth: 2 },
    },
  ],
};

// ── Line chart ────────────────────────────────────────────────────────────────
const lineOption = {
  textStyle: FONT,
  title: { text: 'Monthly Temperature (°C)', left: 'center', textStyle: FONT },
  tooltip: { trigger: 'axis', textStyle: FONT },
  xAxis: {
    type: 'category',
    data: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    axisLabel: { textStyle: FONT },
  },
  yAxis: { type: 'value', min: -5, axisLabel: { textStyle: FONT } },
  series: [
    {
      name: 'Temp',
      type: 'line',
      data: [-2, 0, 5, 12, 18, 23, 26, 25, 19, 12, 5, 0],
      smooth: true,
      lineStyle: { color: '#5470c6', width: 2 },
      itemStyle: { color: '#5470c6', borderColor: '#1a3a9c', borderWidth: 2 },
      areaStyle: { color: 'rgba(84,112,198,0.25)' },
    },
  ],
};

// ── Speedometer gauge ─────────────────────────────────────────────────────────
const gaugeOption = {
  animation: false,
  backgroundColor: '#ffffff',
  textStyle: FONT,
  title: { text: 'Engine RPM', left: 'center', textStyle: FONT },

  series: [
    {
      type: 'gauge',
      startAngle: 220,
      endAngle: -40,
      min: 0,
      max: 8,
      splitNumber: 8,
      radius: '75%',
      axisLine: {
        lineStyle: {
          width: 18,
          color: [
            [0.45, '#91cc75'],
            [0.75, '#fac858'],
            [1,    '#ee6666'],
          ],
        },
      },
      pointer: {
        itemStyle: { color: '#333' },
        length: '65%',
        width: 6,
      },
      axisTick:  { distance: -22, length: 8,  lineStyle: { color: '#fff', width: 2 } },
      splitLine: { distance: -26, length: 18, lineStyle: { color: '#fff', width: 3 } },
      axisLabel: {
        color: '#333',
        distance: 8,
        fontSize: 18,
        fontFamily: 'Caveat, cursive',
        formatter: (v) => v + 'k',
      },
      detail: {
        valueAnimation: false,
        formatter: '{value}k RPM',
        color: '#333',
        fontSize: 24,
        fontFamily: 'Caveat, cursive',
        offsetCenter: [0, '70%'],
      },
      data: [{ value: 3.6, name: 'RPM' }],
    },
  ],
};

// ── Horizontal bar chart ──────────────────────────────────────────────────────
const hbarOption = {
  textStyle: FONT,
  title: { text: 'Department Headcount', left: 'center', textStyle: FONT },
  tooltip: { trigger: 'axis', textStyle: FONT },
  xAxis: { type: 'value', axisLabel: { textStyle: FONT } },
  yAxis: {
    type: 'category',
    data: ['Engineering', 'Design', 'Marketing', 'Sales', 'Support'],
    axisLabel: { textStyle: FONT },
  },
  series: [
    {
      name: 'Headcount',
      type: 'bar',
      data: [42, 15, 23, 31, 18],
      itemStyle: { color: '#73c0de', borderColor: '#1a6a8c', borderWidth: 2 },
    },
  ],
};

// ── Demo ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div style={{ padding: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <ReactECharts option={barOption}        style={{ height: '320px' }} opts={OPTS} />
      <ReactECharts option={groupedBarOption} style={{ height: '320px' }} opts={OPTS} />
      <ReactECharts option={lineOption}       style={{ height: '320px' }} opts={OPTS} />
      <ReactECharts option={hbarOption}       style={{ height: '640px' }} opts={OPTS} />
      <ReactECharts option={gaugeOption}      style={{ height: '400px' }} opts={OPTS} />
    </div>
  );
}
