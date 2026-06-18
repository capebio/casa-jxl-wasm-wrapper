import wmi from 'node-wmi';

wmi.Query({
  namespace: 'root\\LibreHardwareMonitor',
  class: 'Sensor',
  properties: ['Name', 'Value', 'SensorType', 'Parent']
}, (err, result) => {
  if (err) {
    console.error('WMI Error:', err.message);
    process.exit(1);
  }

  if (!result || result.length === 0) {
    console.log('No sensors found');
    process.exit(0);
  }

  console.log(`Found ${result.length} sensors:`);
  result.slice(0, 10).forEach(s => {
    console.log(`  ${s.Name}: ${s.Value} (${s.SensorType}) - Parent: ${s.Parent}`);
  });
});
