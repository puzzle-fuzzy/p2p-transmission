import viteSvg from './assets/vite.svg'

function App() {
  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      <div className="flex items-center">
        <div
          className="rounded-full w-20 h-20 border-2 border-[#2d2d2d] -ml-8 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
        >
          <img src={viteSvg} alt="" />
        </div>

        <div>
          
        </div>

        <div className="flex items-center">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="rounded-full w-20 h-20 border-2 border-[#2d2d2d] -ml-8 first:ml-0 flex justify-center items-center bg-[#3d3d3d] relative"
            >
              <img src={viteSvg} alt="" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default App
