// Must be imported before anything that touches the database.
process.env.VAGUTHU_DB = ':memory:';
// Tests drive the clock and the simulator themselves.
process.env.VAGUTHU_AUTOPILOT = 'false';
