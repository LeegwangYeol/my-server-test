import GPTTorch from "@llami/gpt-torch";

type TorchResult = Awaited<ReturnType<typeof GPTTorch>>;

export type ProcessTorchResult<
  Return = {
    href: string;
    title: string;
    summary: string;
  }[],
> = ({
  links,
    elements,
    elementsFlat,
  }: {
    links: TorchResult["summaryJSON"]["links"];
    elements: TorchResult["summaryJSON"]["elements"];
    elementsFlat: TorchResult["summaryJSON"]["elements"];
  }
) => Return;
