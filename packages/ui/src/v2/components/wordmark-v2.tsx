import { type ComponentProps } from "solid-js"
import wordmark from "../../assets/images/wordmark.png"
import "./wordmark-v2.css"

export function WordmarkV2(props: Pick<ComponentProps<"img">, "class">) {
  return (
    <img
      src={wordmark}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-component="wordmark-v2"
      classList={{ [props.class ?? ""]: !!props.class }}
    />
  )
}
