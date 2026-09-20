/** Banner ad units (Adsterra-style invoke.js iframes). Each unit renders in
 *  its own isolated iframe so the network's global `atOptions` never
 *  collides between banners. Never shown inside the admin panel (/nazmul). */
export const AD_BANNERS = {
  /** 728×90 leaderboard — desktop top/footer slots. */
  leaderboard: {
    id: "1fb6968b89af34ab421dd91969268393",
    width: 728,
    height: 90,
  },
  /** 320×50 mobile banner — phone slots. */
  mobile: {
    id: "09da28a586be9f9ba795c6e18fd31a39",
    width: 320,
    height: 50,
  },
  /** 300×250 medium rectangle — mid-content slots. */
  square: {
    id: "c73d23427afad03198afd45294375738",
    width: 300,
    height: 250,
  },
  /** 468×60 full banner — footer slots. */
  banner: {
    id: "5093337494268b43ddfe851102e5b774",
    width: 468,
    height: 60,
  },
  /** 160×600 wide skyscraper — fixed side rail on very wide screens. */
  skyscraper: {
    id: "1be03b8fc24bbab839c26fc0d5d3b9e8",
    width: 160,
    height: 600,
  },
} as const;

export type AdBannerDef =
  (typeof AD_BANNERS)[keyof typeof AD_BANNERS];
