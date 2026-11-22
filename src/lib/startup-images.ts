// จอ splash ตอนเปิด DocDesk จากไอคอนบน iPhone (apple-touch-startup-image) — iOS ใช้รูปที่ขนาดตรงกับจอเท่านั้น
// รูปสร้างด้วย scripts/make-splash.mjs (โลโก้ + DocDesk บนพื้น --bg) · เพิ่มรุ่นใหม่: เพิ่มแถวที่นี่แล้วรันสคริปต์
/** [ความกว้าง, ความสูง] หน่วย CSS px (แนวตั้ง), อัตราส่วนพิกเซล */
export const IPHONE_SCREENS: [number, number, number][] = [
  [440, 956, 3], // 16 Pro Max, 17 Pro Max
  [420, 912, 3], // iPhone Air
  [402, 874, 3], // 16 Pro, 17, 17 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16, 16e
  [428, 926, 3], // 12/13 Pro Max, 14 Plus
  [390, 844, 3], // 12, 13, 14, 12/13 Pro
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [414, 736, 3], // 6/7/8 Plus
  [375, 667, 2], // SE 2/3, 6/7/8
];

export const splashFile = (w: number, h: number, r: number) => `/splash/iphone-${w * r}x${h * r}.png`;

export const IOS_STARTUP_IMAGES = IPHONE_SCREENS.map(([w, h, r]) => ({
  url: splashFile(w, h, r),
  media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`,
}));
