export const price = (value: number) => value.toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 6,
});
export const size = (value: number, decimals = 5) => value.toLocaleString('en-US', {
  minimumFractionDigits: 0, maximumFractionDigits: decimals,
});
export const time = (value: number) => new Date(value).toLocaleTimeString('en-GB', {
  timeZone: 'UTC', hour12: false,
});
