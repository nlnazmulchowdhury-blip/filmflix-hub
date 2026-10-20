/** Banner ad units. Adsterra-style `invoke.js` iframes (highrevenueformat.com)
 *  render in their own isolated iframe so the network's global `atOptions`
 *  never collides between banners.
 *  Never shown inside the admin panel (/nazmul). */
export const AD_BANNERS = {
  /** 728×90 leaderboard — desktop top/footer slots. */
  leaderboard: {
    id: "e6b49a28844f68ae831f0d14166a680b",
    width: 728,
    height: 90,
  },
  /** 320×50 mobile banner — phone slots. */
  mobile: {
    id: "db1d2329c104f36a903acb63023ba75b",
    width: 320,
    height: 50,
  },
  /** 468×60 full banner — footer slots. */
  banner: {
    id: "33e9e04559e9b1b09e4ea547809b66db",
    width: 468,
    height: 60,
  },
  /** 160×600 wide skyscraper — fixed side rail on very wide screens. */
  skyscraper: {
    id: "7bbe91154c97ede60b21f225dae13469",
    width: 160,
    height: 600,
  },
} as const;

export type AdBannerDef =
  (typeof AD_BANNERS)[keyof typeof AD_BANNERS];
