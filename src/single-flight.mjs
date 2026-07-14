export function runSingleFlight(flights, key, task) {
  const active = flights.get(key)
  if (active) return active

  const flight = Promise.resolve().then(task)
  flights.set(key, flight)
  const clear = () => {
    if (flights.get(key) === flight) flights.delete(key)
  }
  flight.then(clear, clear)
  return flight
}

export function runAfterFlight(flights, key, task) {
  const active = flights.get(key)
  if (!active) return runSingleFlight(flights, key, task)
  return active.catch(() => {}).then(() => runAfterFlight(flights, key, task))
}
