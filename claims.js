// claims.js — every sentence in the article that asserts a *direction* or *shape*
// gets a test here. If new data breaks a claim, the build warns you so the prose
// doesn't silently go stale. Numbers in prose should come from facts.json instead.

export default [
  {
    id: 'washed-beats-natural',
    text: 'Washed coffees rate higher on average than naturals.',
    test: f => f.by_process.Washed && f.by_process.Natural &&
      f.by_process.Washed.mean > f.by_process.Natural.mean,
  },
  {
    id: 'funk-cliff',
    text: 'Ratings hold steady through moderate funk, then fall off at clean/funk 8+.',
    test: f => f.funk_cliff.high.n >= 3 &&
      f.funk_cliff.low.mean - f.funk_cliff.high.mean >= 1,
  },
  {
    id: 'price-weak-positive',
    text: 'Paying more per gram is only weakly associated with higher ratings.',
    test: f => f.correlations.price_per_g_vs_rating.rho > 0 &&
      f.correlations.price_per_g_vs_rating.rho < 0.5,
  },
  {
    id: 'rest-no-effect',
    text: 'Rest time before opening has little relationship to rating.',
    test: f => Math.abs(f.correlations.rest_days_vs_rating.rho) < 0.2,
  },
];
