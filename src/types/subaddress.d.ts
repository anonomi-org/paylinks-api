declare module "subaddress" {
  export function getSubaddress(
    privateViewKey: string,
    publicSpendKey: string,
    majorIndex: number,
    minorIndex: number
  ): string;
}
