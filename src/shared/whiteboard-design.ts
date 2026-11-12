// Bundled Factory design language tokens, CSS starter, official SVG brand marks, and agent guide
// for Droid Office Whiteboard artifacts. Pure ES2022 with no Node or DOM globals so both the server
// (Office MCP + asset loaders) and client (Add/Edit card dialogs) share one source of truth.

export type DesignTheme = 'dark' | 'light';

export const GUIDE_TOPICS = ['all', 'design', 'tokens', 'css', 'interactive', 'artifacts', 'brand'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** Canonical Factory design tokens (verified against factory.com live CSS). */
export const FACTORY_TOKENS = {
  dark: {
    background: '#020202',
    surface: '#0A0A0A',
    surfaceRaised: '#101010',
    border: 'rgba(255, 255, 255, 0.09)',
    borderHex: '#191919',
    borderStrong: 'rgba(255, 255, 255, 0.18)',
    borderStrongHex: '#303030',
    gridLine: '#b4b3b014',
    textPrimary: '#EEEEEE',
    textSecondary: '#8C8C8C',
    textTertiary: 'rgba(255, 255, 255, 0.32)',
    accent: '#EE6018',
    accentBright: '#EF6F2E',
    accentDeep: '#D15010',
    danger: '#EF4444',
    success: '#22C55E',
    warning: '#F59E0B',
    primaryButton: { fill: '#EEEEEE', label: '#020202' },
  },
  light: {
    background: '#F5F5F5',
    surface: '#FAFAFA',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#EBEBEB',
    border: 'rgba(0, 0, 0, 0.06)',
    borderStrong: 'rgba(0, 0, 0, 0.14)',
    gridLine: '#0000000f',
    textPrimary: '#020202',
    textSecondary: '#575757',
    textTertiary: 'rgba(0, 0, 0, 0.40)',
    accent: '#EE6018',
    accentBright: '#EF6F2E',
    accentDeep: '#D15010',
    danger: '#DC2626',
    success: '#16A34A',
    warning: '#D97706',
    primaryButton: { fill: '#020202', label: '#EEEEEE' },
  },
  typography: {
    body: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    chromeCase: 'uppercase',
    trackingPx: [0.5, 1.6] as const,
    eyebrowSizePx: 10,
    eyebrowWeight: 600,
  },
  radius: {
    default: '3px',
    range: ['2px', '6px'] as const,
  },
  borderWidth: '1px',
  canonicalWidthPx: 1280,
  motion: {
    duration: '150ms',
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    forbid: ['spring', 'bounce', 'shimmer'] as const,
  },
  forbidden: ['gradients', 'glows', 'blur halos', 'drop shadows for depth', 'pill radii', 'purple or indigo accents', 'sparkle icons'] as const,
} as const;

export interface BrandLogo {
  file: string;
  surface: DesignTheme;
  viewBox: string;
  use: string;
  svg: string;
}

const ROTOR_PATH =
  'M396.406 180.565C395.606 180.367 394.858 179.997 394.213 179.483C393.568 178.968 393.041 178.321 392.671 177.585C392.299 176.848 392.092 176.04 392.061 175.216C392.031 174.391 392.179 173.571 392.496 172.809C403.427 146.207 408.25 124.922 400.466 116.012C379.851 92.371 297.179 139.382 270.819 155.303C270.113 155.728 269.324 155.995 268.505 156.086C267.687 156.178 266.858 156.091 266.076 155.833C265.294 155.575 264.576 155.152 263.973 154.591C263.369 154.031 262.894 153.346 262.579 152.586C251.499 126.04 239.85 107.576 228.044 106.775C196.75 104.634 171.526 196.337 164.142 226.226C163.945 227.026 163.577 227.775 163.064 228.419C162.55 229.065 161.903 229.591 161.167 229.962C160.432 230.334 159.625 230.541 158.801 230.571C157.977 230.602 157.157 230.454 156.396 230.137C129.794 219.206 108.499 214.383 99.5981 222.167C75.9574 242.782 122.96 325.454 138.881 351.814C139.307 352.519 139.575 353.308 139.667 354.128C139.759 354.946 139.674 355.776 139.416 356.558C139.158 357.341 138.733 358.059 138.172 358.662C137.61 359.266 136.925 359.74 136.163 360.053C109.626 371.133 91.1623 382.782 90.3522 394.588C88.22 425.882 179.915 451.107 209.813 458.491C210.612 458.69 211.358 459.059 212.001 459.573C212.644 460.087 213.169 460.735 213.538 461.47C213.909 462.205 214.117 463.011 214.146 463.834C214.177 464.656 214.03 465.477 213.714 466.236C202.783 492.838 197.96 514.132 205.744 523.034C226.359 546.675 309.041 499.672 335.4 483.751C336.106 483.325 336.896 483.057 337.715 482.965C338.534 482.872 339.363 482.958 340.145 483.217C340.928 483.475 341.645 483.899 342.249 484.461C342.852 485.022 343.327 485.708 343.641 486.469C354.721 513.006 366.36 531.471 378.175 532.281C409.47 534.413 434.693 442.718 442.068 412.82C442.267 412.02 442.637 411.272 443.152 410.629C443.666 409.985 444.314 409.46 445.051 409.089C445.787 408.719 446.595 408.512 447.419 408.483C448.243 408.453 449.063 408.601 449.824 408.919C476.425 419.85 497.711 424.663 506.621 416.888C530.262 396.273 483.25 313.591 467.329 287.232C466.906 286.526 466.64 285.736 466.55 284.919C466.459 284.1 466.546 283.272 466.804 282.49C467.062 281.708 467.485 280.991 468.045 280.388C468.604 279.785 469.288 279.308 470.047 278.992C496.593 267.912 515.057 256.263 515.858 244.457C517.999 213.162 426.295 187.94 396.406 180.565ZM360.503 150.564C366.518 161.346 335.521 233.191 312.467 283.443C312.082 284.283 311.449 284.985 310.652 285.454C309.856 285.923 308.934 286.138 308.012 286.068C307.09 285.998 306.211 285.647 305.495 285.063C304.778 284.478 304.258 283.689 304.003 282.8C294.692 250.127 284.05 211.739 272.663 179.15C272.216 177.871 272.238 176.474 272.726 175.21C273.214 173.946 274.136 172.897 275.325 172.25C303.761 156.719 352.421 136.095 360.503 150.564ZM224.226 159.456C236.098 162.827 264.981 235.547 284.208 287.382C284.529 288.247 284.577 289.191 284.346 290.085C284.114 290.979 283.615 291.781 282.915 292.383C282.214 292.986 281.346 293.359 280.427 293.453C279.508 293.548 278.583 293.359 277.774 292.912C248.063 276.422 213.416 256.776 182.317 241.785C181.1 241.194 180.131 240.191 179.584 238.953C179.036 237.715 178.946 236.323 179.329 235.025C188.481 203.964 208.277 154.94 224.226 159.456ZM134.151 262.11C144.924 256.095 216.778 287.093 267.02 310.147C267.861 310.532 268.563 311.166 269.032 311.963C269.501 312.759 269.716 313.681 269.646 314.602C269.575 315.524 269.225 316.402 268.64 317.119C268.056 317.835 267.267 318.357 266.378 318.611C233.714 327.922 195.316 338.564 162.727 349.952C161.45 350.396 160.055 350.373 158.793 349.885C157.531 349.397 156.483 348.477 155.837 347.288C140.334 318.852 119.673 270.192 134.151 262.11ZM143.043 398.388C146.405 386.516 219.133 357.632 270.968 338.405C271.834 338.085 272.778 338.037 273.672 338.268C274.567 338.5 275.368 338.999 275.971 339.699C276.572 340.4 276.947 341.268 277.041 342.186C277.135 343.105 276.946 344.031 276.499 344.84C260 374.552 240.353 409.198 225.362 440.287C224.777 441.509 223.774 442.482 222.535 443.031C221.296 443.581 219.902 443.671 218.603 443.286C187.541 434.189 138.518 414.338 143.043 398.388ZM245.698 488.463C239.673 477.69 270.679 405.837 293.733 355.594C294.119 354.753 294.753 354.051 295.549 353.582C296.346 353.113 297.267 352.899 298.189 352.969C299.111 353.038 299.99 353.389 300.706 353.973C301.422 354.558 301.943 355.348 302.197 356.237C311.508 388.9 322.151 427.299 333.538 459.887C333.982 461.166 333.957 462.56 333.468 463.823C332.979 465.085 332.056 466.132 330.866 466.777C302.439 482.28 253.77 502.941 245.726 488.463H245.698ZM381.974 479.57C370.093 476.209 341.21 403.481 321.983 351.646C321.661 350.779 321.612 349.833 321.843 348.937C322.074 348.041 322.575 347.238 323.277 346.635C323.979 346.032 324.85 345.659 325.77 345.566C326.691 345.473 327.618 345.665 328.426 346.115C358.129 362.605 392.784 382.261 423.874 397.252C425.095 397.839 426.065 398.842 426.613 400.081C427.161 401.32 427.249 402.713 426.863 404.012C417.719 435.12 397.924 484.095 381.974 479.57ZM472.049 376.916C461.267 382.94 389.423 351.934 339.171 328.88C338.331 328.494 337.628 327.861 337.159 327.064C336.69 326.268 336.477 325.346 336.547 324.425C336.616 323.503 336.966 322.625 337.551 321.908C338.135 321.191 338.925 320.671 339.814 320.417C372.486 311.106 410.876 300.463 443.464 289.075C444.745 288.631 446.141 288.655 447.405 289.145C448.668 289.635 449.717 290.558 450.364 291.748C465.857 320.175 486.519 368.843 472.049 376.916ZM463.157 240.639C459.787 252.52 387.067 281.404 335.233 300.631C334.365 300.953 333.42 301.002 332.524 300.771C331.628 300.539 330.825 300.039 330.222 299.337C329.619 298.635 329.247 297.764 329.154 296.843C329.06 295.923 329.251 294.996 329.702 294.187C346.192 264.485 365.838 229.829 380.829 198.739C381.418 197.521 382.421 196.551 383.66 196.004C384.898 195.456 386.291 195.366 387.589 195.751C418.65 204.894 467.673 224.689 463.157 240.639Z';

const LOCKUP_PATHS =
  '<path d="M323.526 187.064V30.9336L437.518 30.9336V58.8114L353.651 58.8114V95.3936L428.594 95.3936V122.38L353.651 122.38V187.064H323.526Z" fill="FILL"/>\n' +
  '<path d="M457.133 187.064L503.912 52.8495C506.144 46.4464 510.313 40.8966 515.845 36.9699C521.373 33.0432 527.984 30.9331 534.766 30.9336C541.591 30.9326 548.245 33.0689 553.792 37.0424C559.339 41.0159 563.503 46.6267 565.701 53.088L611.255 187.064H580.253L569.321 154.498H499.734L488.359 187.064H457.133ZM508.644 127.287H560.393L541.687 71.0071C539.455 64.2821 529.954 64.2582 527.688 70.9689L508.644 127.287Z" fill="FILL"/>\n' +
  '<path d="M634.679 108.992C634.679 65.0551 670.14 29.1406 714.082 29.1406C746.424 29.1406 772.747 48.772 785.234 76.6498L756.683 84.9058C748.656 69.0663 733.933 57.691 714.082 57.691C685.532 57.691 664.565 80.4416 664.565 108.992C664.565 137.542 685.551 160.069 714.082 160.069C733.933 160.069 748.208 149.809 756.016 133.751L785.009 141.558C772.742 169.221 746.648 188.619 714.082 188.619C670.14 188.619 634.679 152.948 634.679 108.992Z" fill="FILL"/>\n' +
  '<path d="M864.641 187.064V58.8114L815.567 58.8114V30.9336L941.812 30.9336V58.8114L894.527 58.8114V187.064H864.641Z" fill="FILL"/>\n' +
  '<path d="M972.382 107.947C973.064 64.1393 1008.45 29.1071 1052.26 29.3647C1095.97 29.627 1131.18 65.2129 1131.4 109.216C1131.62 153.22 1095.72 188.867 1051.78 188.867C1007.41 188.844 971.69 152.471 972.382 107.947ZM1101.29 109.216C1101.29 80.6661 1080.31 57.2287 1051.78 57.2287C1023.45 57.2287 1002.26 80.647 1002.26 109.216C1002.26 137.543 1023.24 160.727 1051.78 160.727C1080.31 160.727 1101.29 137.767 1101.29 109.216Z" fill="FILL"/>\n' +
  '<path d="M1172.22 187.064V30.9336L1242.48 30.9336C1273.27 30.9336 1296.46 55.468 1296.46 83.7942C1296.44 93.9304 1293.3 103.815 1287.47 112.111C1281.65 120.408 1273.42 126.717 1263.9 130.187L1298.69 187.064H1264.57L1232.22 133.979H1202.35V187.064H1172.22ZM1202.34 107.89L1242.04 107.89C1256.32 107.89 1267.47 97.3968 1267.47 82.9118C1267.47 68.8608 1256.97 57.9291 1242.48 57.9291L1202.35 57.9291L1202.34 107.89Z" fill="FILL"/>\n' +
  '<path d="M1374.53 138.214L1320.33 30.9336L1352.23 30.9336L1389.25 104.313L1426.28 30.9336L1458.17 30.9336L1404.64 137.322V187.064H1374.53V138.214Z" fill="FILL"/>\n' +
  '<path d="M156.793 37.8174C156.383 37.7158 156 37.5264 155.669 37.2631C155.339 36.9994 155.069 36.6679 154.879 36.2906C154.689 35.9134 154.583 35.4994 154.567 35.0773C154.552 34.6547 154.628 34.2345 154.79 33.8443C160.389 20.2178 162.86 9.31469 158.872 4.75026C148.313 -7.35955 105.964 16.7213 92.4616 24.8772C92.1 25.0947 91.6956 25.2315 91.2763 25.2783C90.8571 25.325 90.4326 25.2807 90.032 25.1486C89.6313 25.0164 89.2636 24.7994 88.9546 24.5123C88.6455 24.2252 88.4022 23.8746 88.2405 23.4849C82.5648 9.88703 76.5982 0.429074 70.5504 0.0188951C54.52 -1.07809 41.5994 45.8965 37.8172 61.2066C37.7161 61.6168 37.5277 62.0003 37.2649 62.3303C37.0016 62.6608 36.6701 62.9303 36.2933 63.1206C35.9165 63.3109 35.503 63.4173 35.0809 63.4325C34.6593 63.4483 34.2391 63.3724 33.8489 63.2103C20.2224 57.6109 9.31453 55.1403 4.75487 59.1276C-7.35494 69.6873 16.7216 112.036 24.8775 125.538C25.0954 125.899 25.2328 126.304 25.28 126.724C25.3272 127.143 25.2834 127.568 25.1512 127.968C25.0191 128.37 24.8016 128.737 24.514 129.046C24.2264 129.355 23.8754 129.598 23.4848 129.759C9.89164 135.435 0.433682 141.401 0.0187342 147.449C-1.07349 163.479 45.8967 176.401 61.2117 180.183C61.6209 180.285 62.0029 180.474 62.3325 180.737C62.6616 181.001 62.9306 181.332 63.12 181.709C63.3098 182.085 63.4162 182.498 63.4314 182.92C63.4472 183.341 63.3718 183.761 63.2101 184.151C57.6107 197.777 55.1401 208.685 59.1274 213.245C69.6871 225.354 112.04 201.278 125.543 193.122C125.904 192.904 126.309 192.767 126.729 192.719C127.148 192.672 127.573 192.716 127.974 192.849C128.375 192.981 128.742 193.198 129.051 193.486C129.36 193.774 129.603 194.125 129.764 194.515C135.44 208.108 141.402 217.566 147.454 217.981C163.484 219.074 176.405 172.103 180.183 156.788C180.285 156.379 180.474 155.996 180.738 155.666C181.002 155.336 181.333 155.067 181.711 154.877C182.088 154.688 182.502 154.581 182.924 154.567C183.346 154.551 183.766 154.627 184.156 154.79C197.782 160.389 208.685 162.855 213.25 158.872C225.359 148.312 201.278 105.959 193.122 92.4565C192.906 92.095 192.77 91.6905 192.724 91.2718C192.677 90.8525 192.722 90.428 192.854 90.0279C192.986 89.6272 193.202 89.26 193.489 88.9509C193.776 88.6418 194.126 88.3977 194.515 88.236C208.113 82.5602 217.571 76.5931 217.981 70.5453C219.078 54.515 172.103 41.5948 156.793 37.8174ZM138.402 22.4495C141.483 27.9726 125.605 64.7747 113.796 90.5158C113.598 90.946 113.274 91.3056 112.866 91.546C112.458 91.7864 111.986 91.8961 111.513 91.8603C111.041 91.8245 110.591 91.6447 110.224 91.3457C109.857 91.0462 109.59 90.6417 109.46 90.1862C104.691 73.45 99.2391 53.7857 93.4059 37.0924C93.177 36.4371 93.1885 35.7216 93.4384 35.0744C93.6883 34.4267 94.1605 33.8892 94.77 33.5577C109.336 25.6021 134.262 15.0376 138.402 22.4495ZM68.5949 27.0044C74.676 28.7309 89.4711 65.9814 99.3201 92.5333C99.4847 92.9769 99.509 93.46 99.3907 93.9184C99.272 94.3762 99.0163 94.7869 98.6577 95.0955C98.2985 95.4041 97.854 95.5953 97.3832 95.6435C96.9125 95.6922 96.4384 95.5953 96.0244 95.3664C80.8049 86.9196 63.0575 76.8559 47.1273 69.177C46.5034 68.8741 46.0074 68.3604 45.727 67.7261C45.4465 67.0922 45.4002 66.3792 45.5963 65.7143C50.2847 49.8032 60.4247 24.6911 68.5949 27.0044ZM22.4546 79.5883C27.9729 76.5072 64.7793 92.3854 90.5156 104.195C90.9463 104.392 91.3059 104.717 91.5463 105.125C91.7867 105.533 91.8964 106.005 91.8606 106.477C91.8244 106.949 91.645 107.399 91.3455 107.766C91.0465 108.133 90.642 108.4 90.1865 108.53C73.455 113.3 53.7855 118.751 37.0922 124.584C36.4378 124.812 35.7234 124.8 35.0771 124.55C34.4308 124.3 33.8938 123.829 33.5628 123.22C25.6215 108.654 15.038 83.7283 22.4546 79.5883ZM27.0094 149.396C28.7312 143.314 65.986 128.519 92.5379 118.67C92.9815 118.506 93.4651 118.481 93.923 118.6C94.3813 118.718 94.792 118.974 95.1005 119.333C95.4087 119.691 95.6004 120.136 95.6486 120.607C95.6967 121.077 95.5999 121.552 95.371 121.966C86.9194 137.186 76.8557 154.933 69.1768 170.858C68.8768 171.484 68.3631 171.983 67.7283 172.264C67.0939 172.545 66.3799 172.592 65.7141 172.394C49.803 167.734 24.6915 157.566 27.0094 149.396ZM79.5934 195.536C76.5075 190.018 92.39 153.211 104.199 127.475C104.397 127.044 104.722 126.685 105.129 126.444C105.538 126.204 106.009 126.094 106.482 126.13C106.954 126.166 107.404 126.345 107.771 126.644C108.138 126.944 108.405 127.348 108.535 127.804C113.304 144.535 118.756 164.205 124.589 180.898C124.817 181.553 124.804 182.268 124.553 182.914C124.302 183.561 123.83 184.097 123.22 184.428C108.659 192.369 83.7286 202.952 79.6077 195.536H79.5934ZM149.4 190.981C143.314 189.259 128.519 152.004 118.67 125.453C118.505 125.008 118.48 124.523 118.599 124.065C118.717 123.606 118.973 123.194 119.333 122.886C119.693 122.577 120.139 122.386 120.61 122.338C121.082 122.29 121.557 122.389 121.971 122.619C137.185 131.066 154.938 141.135 170.863 148.814C171.488 149.115 171.985 149.628 172.266 150.263C172.547 150.897 172.592 151.611 172.394 152.276C167.71 168.211 157.57 193.299 149.4 190.981ZM195.54 138.397C190.017 141.482 153.216 125.6 127.475 113.791C127.044 113.593 126.684 113.269 126.444 112.861C126.204 112.453 126.094 111.981 126.13 111.508C126.166 111.036 126.345 110.586 126.645 110.219C126.944 109.852 127.348 109.586 127.804 109.456C144.54 104.686 164.205 99.234 180.898 93.4009C181.554 93.1734 182.269 93.1858 182.916 93.4366C183.564 93.6875 184.101 94.1602 184.432 94.7702C192.369 109.332 202.952 134.261 195.54 138.397ZM190.986 68.5898C189.259 74.6757 152.009 89.4713 125.457 99.3203C125.013 99.4854 124.528 99.5102 124.07 99.3919C123.611 99.2731 123.199 99.017 122.89 98.6574C122.582 98.2977 122.391 97.8518 122.343 97.3801C122.295 96.9089 122.393 96.4338 122.624 96.0193C131.071 80.8046 141.135 63.0524 148.813 47.127C149.115 46.5027 149.629 46.0061 150.263 45.7257C150.898 45.4453 151.611 45.399 152.276 45.596C168.187 50.2796 193.299 60.4196 190.986 68.5898Z" fill="FILL"/>';

const DOT_PATH =
  'M126.721 123V36.3601H180.413V46.3664H137.215V75.6532H178.217V85.6594H137.215V123H126.721ZM190.86 123L217.218 36.3601H231.373L257.731 123H246.505L239.427 98.3504H209.164L202.086 123H190.86ZM224.295 45.8783L212.093 88.1H236.498L224.295 45.8783ZM297.709 124.952C276.964 124.952 265.493 107.502 265.493 79.8021C265.493 51.8577 276.964 34.4077 297.709 34.4077C312.962 34.4077 324.311 44.9021 327.972 62.8402L316.745 63.5724C313.938 51.1255 306.739 44.6581 297.709 44.6581C283.919 44.6581 276.476 57.349 276.476 79.8021C276.476 102.133 283.919 114.702 297.709 114.702C307.715 114.702 315.159 107.624 317.599 93.8353L328.704 94.4455C325.531 113.482 314.06 124.952 297.709 124.952ZM365.386 123V46.6105H338.906V36.3601H402.361V46.6105H375.881V123H365.386ZM443.803 124.952C423.302 124.952 411.831 108.723 411.831 79.8021C411.831 50.6374 423.302 34.4077 443.803 34.4077C464.303 34.4077 475.774 50.6374 475.774 79.8021C475.774 108.723 464.303 124.952 443.803 124.952ZM443.803 114.702C457.226 114.702 464.792 102.499 464.792 79.8021C464.792 57.1049 457.226 44.6581 443.803 44.6581C430.38 44.6581 422.814 57.1049 422.814 79.8021C422.814 102.499 430.38 114.702 443.803 114.702ZM488.905 123V36.3601H515.263C533.446 36.3601 544.794 46.1224 544.794 62.2301C544.794 72.4804 537.839 80.0462 530.151 82.6087C538.449 84.1951 542.476 88.8322 543.33 98.1063L545.526 123H535.032L532.958 99.4486C532.225 91.3948 528.687 88.1 517.46 88.1H499.4V123H488.905ZM499.4 77.8497H515.263C527.222 77.8497 533.812 72.2364 533.812 62.2301C533.812 52.2238 527.222 46.6105 515.263 46.6105H499.4V77.8497ZM585.016 123V87.6119L558.414 36.3601H570.372L590.141 76.8734L609.91 36.3601H621.868L595.51 87.6119V123H585.016ZM655.744 123V108.113H670.876V123H655.744ZM703.044 123L729.402 36.3601H743.557L769.915 123H758.688L751.611 98.3504H721.348L714.27 123H703.044ZM736.479 45.8783L724.276 88.1H748.682L736.479 45.8783ZM782.802 123V112.75H804.401V46.6105H782.802V36.3601H836.494V46.6105H814.896V112.75H836.494V123H782.802Z';

function svgWrap(viewBox: string, inner: string): string {
  return `<svg preserveAspectRatio="xMidYMid meet" width="100%" height="100%" overflow="visible" style="display: block;" viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">\n${inner}\n</svg>\n`;
}

/** Inline Factory rotor mark sized via CSS, using `currentColor` for UI chrome inside generated artifacts. */
export const FACTORY_ROTOR_INLINE_SVG = `<svg viewBox="0 0 613 650" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="${ROTOR_PATH}" fill="currentColor"/></svg>`;

/** Official Factory Guild brand kit SVG files, preserved verbatim for dark and light surfaces. */
export const FACTORY_LOGOS: Readonly<Record<string, BrandLogo>> = {
  'rotor-white.svg': {
    file: 'rotor-white.svg',
    surface: 'dark',
    viewBox: '0 0 613 650',
    use: 'Factory rotor (pinwheel droid mark) alone, for dark backgrounds (#020202 / #0A0A0A).',
    svg: svgWrap('0 0 613 650', `<path d="${ROTOR_PATH}" fill="white"/>`),
  },
  'rotor-black.svg': {
    file: 'rotor-black.svg',
    surface: 'light',
    viewBox: '0 0 613 650',
    use: 'Factory rotor (pinwheel droid mark) alone, for light backgrounds (#F5F5F5 / #FFFFFF).',
    svg: svgWrap('0 0 613 650', `<path d="${ROTOR_PATH}" fill="black"/>`),
  },
  'factory-lockup-white.svg': {
    file: 'factory-lockup-white.svg',
    surface: 'dark',
    viewBox: '0 0 1459 218',
    use: 'Full Factory lockup (rotor + FACTORY wordmark) for dark backgrounds.',
    svg: svgWrap('0 0 1459 218', LOCKUP_PATHS.replaceAll('FILL', 'white')),
  },
  'factory-lockup-black.svg': {
    file: 'factory-lockup-black.svg',
    surface: 'light',
    viewBox: '0 0 1459 218',
    use: 'Full Factory lockup (rotor + FACTORY wordmark) for light backgrounds.',
    svg: svgWrap('0 0 1459 218', LOCKUP_PATHS.replaceAll('FILL', 'black')),
  },
  'dot-logo-dark.svg': {
    file: 'dot-logo-dark.svg',
    surface: 'dark',
    viewBox: '0 0 847 159',
    use: 'factory.ai wordmark with orange dot (#EF6F2E) for dark backgrounds.',
    svg: svgWrap('0 0 847 159', `<path d="${DOT_PATH}" fill="white"/>\n<circle cx="36.225" cy="76.475" r="36.225" fill="#EF6F2E"/>`),
  },
  'dot-logo-light.svg': {
    file: 'dot-logo-light.svg',
    surface: 'light',
    viewBox: '0 0 847 159',
    use: 'factory.ai wordmark with orange dot (#EF6F2E) for light backgrounds.',
    svg: svgWrap('0 0 847 159', `<path d="${DOT_PATH}" fill="black"/>\n<circle cx="36.225" cy="76.475" r="36.225" fill="#EF6F2E"/>`),
  },
};

/**
 * Reusable Factory design stylesheet for 1280px Whiteboard artifacts.
 * Supports dark product surfaces by default and light marketing/doc surfaces via `data-theme="light"`.
 */
export const FACTORY_ARTIFACT_CSS = `:root {
  --bg: #020202;
  --surface: #0a0a0a;
  --surface-raised: #101010;
  --surface-sunken: #060606;
  --border: rgba(255, 255, 255, 0.09);
  --border-strong: rgba(255, 255, 255, 0.18);
  --grid-line: rgba(180, 179, 176, 0.08);
  --text: #eeeeee;
  --text-secondary: #8c8c8c;
  --text-tertiary: rgba(255, 255, 255, 0.32);
  --accent: #ee6018;
  --accent-bright: #ef6f2e;
  --accent-deep: #d15010;
  --danger: #ef4444;
  --success: #22c55e;
  --warning: #f59e0b;
  --cta-fill: #eeeeee;
  --cta-ink: #020202;
  --font-sans: Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius: 3px;
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur: 150ms;
}
[data-theme="light"] {
  --bg: #f5f5f5;
  --surface: #fafafa;
  --surface-raised: #ffffff;
  --surface-sunken: #ebebeb;
  --border: rgba(0, 0, 0, 0.06);
  --border-strong: rgba(0, 0, 0, 0.15);
  --grid-line: rgba(0, 0, 0, 0.06);
  --text: #020202;
  --text-secondary: #575757;
  --text-tertiary: rgba(0, 0, 0, 0.40);
  --cta-fill: #020202;
  --cta-ink: #eeeeee;
  --danger: #dc2626;
  --success: #16a34a;
  --warning: #d97706;
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  width: 1280px;
  background: var(--bg);
  color: var(--text);
  font: 400 15px/1.6 var(--font-sans);
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent-bright); text-decoration: none; border-bottom: 1px solid rgba(238, 96, 24, 0.35); transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease); }
a:hover { color: var(--accent); border-bottom-color: var(--accent); }
.wb-shell { width: 1280px; min-height: 100vh; display: flex; flex-direction: column; }
.wb-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 40px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.wb-band-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wb-rotor { width: 15px; height: 15px; color: var(--accent); flex: none; }
.wb-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 10px/1.2 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-secondary);
}
.wb-eyebrow .wb-idx { color: var(--accent); font-variant-numeric: tabular-nums; }
.wb-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text-secondary);
  font: 600 10px/1 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.wb-badge.accent { border-color: rgba(238, 96, 24, 0.45); color: var(--accent); }
.wb-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px 24px;
}
.wb-panel.raised { background: var(--surface-raised); }
.wb-rule { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
.wb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: var(--text);
  font: 600 11px/1 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  text-decoration: none;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background-color var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.wb-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-bright); }
.wb-btn:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.wb-btn.primary { background: var(--cta-fill); border-color: var(--cta-fill); color: var(--cta-ink); }
.wb-btn.primary:hover:not(:disabled) { background: var(--accent-bright); border-color: var(--accent-bright); color: #020202; }
.wb-btn.sm { height: 26px; padding: 0 9px; font-size: 10px; gap: 6px; }
.wb-btn.active, .wb-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.wb-btn:disabled, .wb-btn[aria-disabled="true"] { opacity: 0.48; cursor: not-allowed; }
.wb-btn[data-wb-ping-state="sent"] { border-color: var(--accent); color: var(--accent); opacity: 0.85; }
.wb-btn[data-wb-ping-state="sent"]::after { content: " · SENT"; font-weight: 600; }
.wb-btn[data-wb-ping-state="unavailable"] { opacity: 0.38; border-style: dashed; }
.wb-input, .wb-textarea, .wb-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font: 400 14px/1.45 var(--font-sans);
  transition: border-color var(--dur) var(--ease);
}
.wb-input:focus, .wb-textarea:focus, .wb-select:focus { border-color: var(--accent); outline: none; }
.wb-table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
.wb-table th, .wb-table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
.wb-table th {
  font: 600 10px/1.2 var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
  background: var(--surface);
  border-bottom-color: var(--border-strong);
}
.wb-callout {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  margin: 16px 0;
  border: 1px solid var(--border-strong);
  border-left: 2px solid var(--text-secondary);
  border-radius: var(--radius);
  background: var(--surface);
}
.wb-callout.note, .wb-callout.tip { border-left-color: var(--accent); }
.wb-callout.important { border-left-color: var(--text); }
.wb-callout.warning { border-left-color: var(--warning); }
.wb-callout.caution { border-left-color: var(--danger); }
.wb-callout-tag { font: 600 10px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--text-secondary); }
.wb-callout.note .wb-callout-tag, .wb-callout.tip .wb-callout-tag { color: var(--accent); }
.wb-callout.warning .wb-callout-tag { color: var(--warning); }
.wb-callout.caution .wb-callout-tag { color: var(--danger); }`;

/** Ready-to-edit 1280px Factory HTML starter with tokens, numbered eyebrows, form state, and ping actions. */
export const FACTORY_HTML_STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Proposal</title>
<style>
${FACTORY_ARTIFACT_CSS}
main { max-width: 1120px; margin: 0 auto; padding: 36px 40px 64px; display: flex; flex-direction: column; gap: 28px; }
h1 { margin: 6px 0 0; font-size: 28px; font-weight: 500; letter-spacing: -0.02em; line-height: 1.2; }
.lead { margin: 8px 0 0; color: var(--text-secondary); max-width: 72ch; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
h2 { margin: 6px 0 10px; font-size: 17px; font-weight: 500; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; padding-top: 8px; }
</style>
</head>
<body>
<div class="wb-shell">
  <header class="wb-band" data-wb-id="header">
    <div class="wb-band-left">
      <span class="wb-eyebrow"><span class="wb-idx">00</span> ARTIFACT</span>
    </div>
    <span class="wb-badge">1280PX · FACTORY</span>
  </header>
  <main>
    <section data-wb-id="overview">
      <div class="wb-eyebrow"><span class="wb-idx">01</span> OVERVIEW</div>
      <h1>Proposal title</h1>
      <p class="lead">Summarize the architecture, trade-offs, and verification gates so the owner can mark up specific sections or trigger the build directly.</p>
    </section>
    <section class="grid-2" data-wb-id="options">
      <div class="wb-panel raised" data-wb-id="option-a">
        <div class="wb-eyebrow"><span class="wb-idx">02</span> OPTION A</div>
        <h2>Recommended path</h2>
        <p class="lead">Flat industrial surfaces, 1px hairlines, 3px corners, zero gradients or glows.</p>
      </div>
      <div class="wb-panel" data-wb-id="option-b">
        <div class="wb-eyebrow"><span class="wb-idx">03</span> OPTION B</div>
        <h2>Minimal fallback</h2>
        <p class="lead">Smaller change footprint when full migration should wait for a follow-up.</p>
      </div>
    </section>
    <section class="wb-panel" data-wb-id="decision">
      <div class="wb-eyebrow"><span class="wb-idx">04</span> DECISION</div>
      <label class="wb-eyebrow" for="notes" style="margin: 12px 0 6px; display: block;">NOTES FOR AGENT</label>
      <textarea id="notes" name="notes" class="wb-textarea" rows="2" placeholder="Optional constraints…"></textarea>
      <div class="actions">
        <button type="button" class="wb-btn primary" data-wb-action="approve-a" data-wb-ping="Approved Option A. Proceed with implementation and read state.fields.notes.">BUILD OPTION A →</button>
        <button type="button" class="wb-btn" data-wb-action="approve-b" data-wb-ping="Approved Option B. Proceed with minimal fallback and read state.fields.notes.">BUILD OPTION B</button>
      </div>
    </section>
  </main>
</div>
</body>
</html>
`;

const DESIGN_RULES_SECTION = `## Factory Design Language (Whiteboard Standard)

Factory has two moods:
- **Dark product mood (default for apps, dashboards, proofs, tools, video, diagrams):** \`#020202\` base, \`#0A0A0A\` panel, \`#101010\` raised, \`#EEEEEE\` primary ink, \`#8C8C8C\` secondary ink, light-filled primary CTAs (\`#EEEEEE\` fill, \`#020202\` ink).
- **Light document mood (opt-in for print-style specs or marketing copy):** \`#F5F5F5\` page, \`#FFFFFF\` raised, \`#EBEBEB\` sunken, \`#020202\` ink, black-filled primary CTAs.

Core rules, in priority order:
1. **Flat industrial surfaces only.** Never use gradients, ambient glows, blur halos, glassmorphism, or drop shadows for depth. Separate layers with 1px hairlines and subtle surface steps.
2. **1px hairlines everywhere.** Dark: \`rgba(255,255,255,0.09)\` default, \`rgba(255,255,255,0.18)\` interactive/strong. Light: \`rgba(0,0,0,0.06)\` default, \`rgba(0,0,0,0.15)\` strong.
3. **Near-square corners (~3px, range 2–6px).** Never use pill buttons (\`999px\`) or generic \`10–14px\` SaaS card radii.
4. **Typography.** Body copy and headings in Geist (fallback \`system-ui, sans-serif\`) in sentence case. All chrome — buttons, badges, table headers, status tags, eyebrows — in **UPPERCASE Geist Mono** with \`0.08em–0.12em\` letter spacing and \`tabular-nums\`. Keep keyboard symbols (\`⌘↩\`) outside \`text-transform: uppercase\` spans.
5. **Numbered eyebrows.** Section headers lead with a Factory-orange two-digit index + tracked uppercase mono label (\`01 ARCHITECTURE\`, \`02 BENCHMARKS\`), 10px semibold.
6. **Factory orange (\`#EE6018\`), used sparingly.** Use \`#EE6018\` (hover \`#EF6F2E\`, pressed \`#D15010\`) for eyebrow numbers, focus rings, hover border/text shifts, live indicators, and the single highlighted series in a chart or critical node in a diagram. Never flood large backgrounds with orange or use purple/indigo/cyan accents.
7. **Buttons invert against their surface.** Primary CTA on dark is \`#EEEEEE\` fill with \`#020202\` uppercase mono text and a trailing \`→\` (\`APPROVE PLAN →\`). Secondary buttons use \`#101010\` with a 1px hairline border shifting to orange on hover.
8. **Motion & iconography.** Quick mechanical transitions (\`150ms cubic-bezier(0.4, 0, 0.2, 1)\`), never springs, bounces, or shimmer. Use thin monochrome strokes or the official Factory rotor mark — never sparkles or magic-wand icons.`;

const ARTIFACTS_SECTION = `## Choosing the Right Whiteboard Artifact Type

Prefer dedicated artifact sources in \`whiteboard_card\` before hand-writing boilerplate HTML:
- **Markdown (\`source: { markdown: "# ..." }\` or \`source: { markdownFile: "plan.md" }\`):** Rendered automatically in Factory dark (or \`theme: "light"\`) industrial typography at 1280px, with numbered \`01\` eyebrows on \`##\` headings, a sticky section index rail, stable \`data-wb-id\` anchors on every section and table row, copyable code blocks, \`COPY MD\`, GitHub \`[!NOTE]\`/\`[!WARNING]\` callouts, interactive task-list checkboxes (\`- [ ]\` saved to \`state.fields\` with a live completion badge), click-to-zoom embedded images, relative local images collected automatically, and optional \`actions\` buttons (\`[{ action, label, ping, primary }]\`) or a \`\`\`wb-actions\`\`\` JSON block!
- **Video (\`source: { video: "demo.mp4", poster?: "poster.jpg", caption?: "..." }\`):** Dedicated 1280px Factory cinema player with play/pause, hover-preview scrub timeline, frame-step (\`-1F\` / \`+1F\`, \`,\` / \`.\`), speed (\`0.5×–2×\`), loop, mute, \`PIN @TIME\` timecode helper, direct download, built-in full-screen player mode (\`FULL\` button or double-click), clickable timestamp seek from comments, and safe headless PNG rendering without decoding huge video streams.
- **Image (\`source: { image: "proof.png", caption?: "..." }\`):** Supports PNG, JPEG, WebP, GIF, and SVG on a clean Factory frame with pixel dimensions, \`GRID BG\` and \`LIGHT BG\` backdrop toggles for transparent assets, direct download, and full-screen inspection, anchored at \`data-wb-id="image"\`.
- **Live links (\`source: { link: "path" }\`):** Works with \`.html\`, \`.md\`, images (\`.png\`/\`.jpg\`/\`.webp\`/\`.gif\`/\`.svg\`), videos (\`.mp4\`/\`.webm\`/\`.mov\`), or a folder package (\`entry?: "index.html"\`). Editing the file on disk updates the card live.
- **Custom HTML (\`source: { html }\`, \`{ file }\`, or \`{ dir }\`):** Use when building bespoke interactive tools, charts, side-by-side diffs, configurators, or multi-step forms. Start from \`FACTORY_ARTIFACT_CSS\` (fetch with \`topic: "css"\`). Pass \`show: true\` on \`create\` or \`update\` to put the card on the 3D office wall in the same call.`;

const INTERACTIVE_SECTION = `## Anchors, State & Action/Ping Buttons

1. **Stable comment anchors:** Put \`data-wb-id="unique-slug"\` on every section, option card, diagram node, and table row the owner might comment on so marks stay attached when you revise the card.
2. **Canonical width:** Lay out pages at \`1280px\` wide (any height). Both the window, Android, the 3D wall, and \`whiteboard_read({ png: true })\` share this 1280px coordinate space.
3. **Zero-JS forms & \`window.whiteboard\`:**
   - Inputs, selects, and textareas with \`name\` or \`id\` auto-save to \`state.fields.<name>\` (use \`data-wb-ignore\` on transient UI controls like scrubbers or filter boxes).
   - Rich apps read/write \`window.whiteboard.state.get(path?)\`, \`.set(path, val)\`, \`.merge(obj)\`, \`.del(path)\`, and listen via \`window.whiteboard.on('state' | 'ready' | 'mode' | 'seek', fn)\`.
   - Check \`window.whiteboard.rendering\`: when \`true\`, headless Chromium is capturing a PNG snapshot — skip network side effects, autoplay audio, or heavy media buffering.
4. **Buttons that wake/steer you (\`data-wb-ping\`):**
   - Plain \`data-wb-action="save"\` only records \`state.actions.save\` for your next read.
   - Any button asking you to act MUST carry \`data-wb-ping\`:
     \`<button class="wb-btn primary" data-wb-action="ship" data-wb-ping="Owner approved shipping. Merge and deploy.">APPROVE & SHIP →</button>\`
   - Style \`[data-wb-ping-state="ready"]\`, \`[data-wb-ping-state="sent"]\`, and \`[data-wb-ping-state="unavailable"]\` (\`FACTORY_ARTIFACT_CSS\` styles all three automatically). Re-arm a spent button with \`whiteboard_state\` \`op: "del"\`, \`path: "pinged.<action>"\`.
5. **Fast feedback checks:** Use \`whiteboard_read({ onlyChanged: true })\` to inspect only cards with new owner feedback since your last read, or \`peek: true\` to check state without advancing your read point.`;

const BRAND_SECTION = `## Official Factory Brand Assets

Never redraw, recolor, stretch, or ask an image model to generate the Factory logo or rotor mark. Use the bundled SVG files verbatim (pass \`exportLogosTo: "dir"\` to \`whiteboard_guide\` to write them into your worktree):
- \`rotor-white.svg\` / \`rotor-black.svg\` (\`viewBox="0 0 613 650"\`): Factory pinwheel droid mark for dark / light backgrounds.
- \`factory-lockup-white.svg\` / \`factory-lockup-black.svg\` (\`viewBox="0 0 1459 218"\`): Rotor + FACTORY wordmark for dark / light backgrounds.
- \`dot-logo-dark.svg\` / \`dot-logo-light.svg\` (\`viewBox="0 0 847 159"\`): \`factory.ai\` wordmark with \`#EF6F2E\` dot for dark / light backgrounds.

Keep clear space around any mark of at least the height of the mark. Use Factory logos only on Factory / Droid Office materials.`;

/** Formats the requested Whiteboard + Factory Design guide section(s) for `whiteboard_guide`. */
export function formatWhiteboardGuide(topic: GuideTopic = 'all'): string {
  switch (topic) {
    case 'design':
      return DESIGN_RULES_SECTION;
    case 'tokens':
      return `## Factory Design Tokens (JSON)\n\n\`\`\`json\n${JSON.stringify(FACTORY_TOKENS, null, 2)}\n\`\`\``;
    case 'css':
      return `## Factory Whiteboard CSS & Starter HTML\n\n### Base Stylesheet (\`FACTORY_ARTIFACT_CSS\`)\n\`\`\`css\n${FACTORY_ARTIFACT_CSS}\n\`\`\`\n\n### 1280px Starter Page\n\`\`\`html\n${FACTORY_HTML_STARTER}\`\`\``;
    case 'interactive':
      return INTERACTIVE_SECTION;
    case 'artifacts':
      return ARTIFACTS_SECTION;
    case 'brand':
      return BRAND_SECTION;
    case 'all':
      return [
        '# Droid Office Whiteboard & Factory Design Guide',
        ARTIFACTS_SECTION,
        DESIGN_RULES_SECTION,
        INTERACTIVE_SECTION,
        BRAND_SECTION,
        'Tip: call `whiteboard_guide` with `topic: "css"` for the ready-to-paste Factory stylesheet & 1280px HTML starter, `topic: "tokens"` for raw JSON tokens, or `exportLogosTo: "assets"` to write the official Factory SVG marks into your worktree.',
      ].join('\n\n');
  }
}
