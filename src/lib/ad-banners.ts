/** Banner ad units. Adsterra-style `invoke.js` iframes (highrevenueformat.com)
 *  render in their own isolated iframe so the network's global `atOptions`
 *  never collides between banners. A separate profitableratecpmnetwork
 *  container unit + site-wide tags are configured below.
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
  /** 300×250 medium rectangle — mid-content slots. */
  square: {
    id: "558d8844d1877697144878c09bfbc1cb",
    width: 300,
    height: 250,
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
  /** 160×300 half-page — secondary side rail / inline rail unit. */
  halfpage: {
    id: "15a329d32e3b370b3fd549694215e184",
    width: 160,
    height: 300,
  },
} as const;

export type AdBannerDef =
  (typeof AD_BANNERS)[keyof typeof AD_BANNERS];

/** profitableratecpmnetwork container (in-page) banner unit. Renders the
 *  network's async invoke.js into a dedicated, isolated iframe whose body
 *  carries the required `container-<hash>` div. */
export const PRCONTAINER = {
  hash: "dc3900395355a642e4458c9d32986379",
  invokeSrc:
    "https://pl31851418.profitableratecpmnetwork.com/dc3900395355a642e4458c9d32986379/invoke.js",
  width: 300,
  height: 250,
} as const;
